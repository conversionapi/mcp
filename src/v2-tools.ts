/**
 * V2 tool registration: 18 tools wrapping `client.v2` (perceive, discover,
 * web search, distill, ingest, watch).
 *
 * Deliberately NOT exposed: get_webhook_secret / rotate_webhook_secret —
 * returning a signing secret into LLM context (transcripts, logs) is a
 * leak, and speculative rotation would break live webhook verification.
 *
 * Every tool returns a text summary plus the full camelCase SDK result as
 * structuredContent. Markdown artifacts are inlined when small enough.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  CssField,
  Enconvert,
  IngestJob,
  PerceiveBatchResult,
  PerceiveOptions,
  PerceiveResult,
  Watcher,
} from "@enconvert/node-sdk";
import { z } from "zod";

import { errorResult, fetchTextInline, pdfOptionsSchema, toPdfOptions, type ContentBlock } from "./shared.js";
import {
  CANCEL_INGEST_JOB_DESCRIPTION,
  CANCEL_INGEST_JOB_TITLE,
  CREATE_WATCHER_DESCRIPTION,
  CREATE_WATCHER_TITLE,
  DELETE_WATCHER_DESCRIPTION,
  DELETE_WATCHER_TITLE,
  DISCOVER_URLS_DESCRIPTION,
  DISCOVER_URLS_TITLE,
  EXTRACT_STRUCTURED_DESCRIPTION,
  EXTRACT_STRUCTURED_TITLE,
  GET_INGEST_JOB_DESCRIPTION,
  GET_INGEST_JOB_TITLE,
  GET_PERCEIVE_BATCH_DESCRIPTION,
  GET_PERCEIVE_BATCH_TITLE,
  GET_PERCEIVE_OPERATION_DESCRIPTION,
  GET_PERCEIVE_OPERATION_TITLE,
  GET_WATCHER_DESCRIPTION,
  GET_WATCHER_SNAPSHOTS_DESCRIPTION,
  GET_WATCHER_SNAPSHOTS_TITLE,
  GET_WATCHER_TITLE,
  LIST_INGEST_JOBS_DESCRIPTION,
  LIST_INGEST_JOBS_TITLE,
  LIST_WATCHERS_DESCRIPTION,
  LIST_WATCHERS_TITLE,
  PERCEIVE_BATCH_DESCRIPTION,
  PERCEIVE_BATCH_TITLE,
  PERCEIVE_URL_DESCRIPTION,
  PERCEIVE_URL_TITLE,
  RETRY_INGEST_WEBHOOK_DESCRIPTION,
  RETRY_INGEST_WEBHOOK_TITLE,
  START_INGEST_DESCRIPTION,
  START_INGEST_TITLE,
  UPDATE_WATCHER_DESCRIPTION,
  UPDATE_WATCHER_TITLE,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_TITLE,
} from "./descriptions-v2.js";

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

const OUTPUT_NAMES = [
  "markdown",
  "markdown_fit",
  "html_cleaned",
  "html_raw",
  "screenshot",
  "screenshot_full_page",
  "pdf",
  "links",
  "images",
  "structured",
] as const;

const EXTRACT_NAMES = [
  "tables",
  "prices",
  "contacts",
  "metadata",
  "main_content",
  "headings",
  "structured_data",
  "technologies",
  "all",
] as const;

const BLOCK_RESOURCES = [
  "image",
  "media",
  "font",
  "stylesheet",
  "script",
  "xhr",
  "fetch",
  "websocket",
  "manifest",
  "other",
] as const;

const DISCOVER_MODES = ["sitemap", "crawl", "hybrid"] as const;

// Shared render options for perceive_url / perceive_batch.
const perceiveOptionShape = {
  outputs: z
    .array(z.enum(OUTPUT_NAMES))
    .optional()
    .describe("Artifacts to produce. Default: ['markdown','structured']."),
  extract: z
    .array(z.enum(EXTRACT_NAMES))
    .optional()
    .describe(
      "Heuristic extraction targets. Implemented today: tables, metadata, main_content, headings, structured_data; others return a warning.",
    ),
  schema: z
    .record(z.unknown())
    .optional()
    .describe(
      "JSON schema for LLM structured extraction (plan-gated). Combine with outputs including 'structured'.",
    ),
  wait_for: z
    .string()
    .max(1024)
    .optional()
    .describe("CSS selector (optionally 'css:...') or 'js:<expr>' to await after navigation."),
  wait_timeout_ms: z.number().int().min(0).max(60000).optional().describe("Default 30000."),
  js_code: z
    .string()
    .max(20000)
    .optional()
    .describe("JavaScript executed after page load, before capture."),
  viewport_width: z.number().int().min(320).max(3840).optional().describe("Default 1920."),
  viewport_height: z.number().int().min(240).max(2160).optional().describe("Default 1080."),
  cache_mode: z
    .enum(["enabled", "bypass", "refresh"])
    .optional()
    .describe("Default 'enabled' (~1h cache). 'bypass' skips the cache; 'refresh' re-renders."),
  pdf_options: pdfOptionsSchema.optional().describe("Only meaningful when outputs includes 'pdf'."),
  block_resources: z
    .array(z.enum(BLOCK_RESOURCES))
    .optional()
    .describe("Resource types the browser should not load (faster, cheaper renders)."),
  respect_robots: z.boolean().optional().describe("Default false."),
  mobile: z.boolean().optional().describe("Emulate a mobile device. Default false."),
};

const perceiveUrlSchema = z.object({
  url: z.string().url().describe("The http(s) URL to render."),
  ...perceiveOptionShape,
});

const perceiveBatchSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(1000).describe("URLs to render with the shared options."),
  output_mode: z
    .enum(["manifest", "zip"])
    .optional()
    .describe("'manifest' (default) or 'zip' (bundle all artifacts once complete)."),
  ...perceiveOptionShape,
});

const operationIdSchema = z.object({
  operation_id: z.string().describe("Perceive operation ID (per_...)."),
});

const batchJobIdSchema = z.object({
  job_id: z.string().describe("Perceive batch job ID returned by perceive_batch."),
});

const discoverSchema = z.object({
  url: z.string().url().describe("Base http(s) URL of the site."),
  mode: z
    .enum(DISCOVER_MODES)
    .optional()
    .describe("'sitemap' (sitemap.xml only), 'crawl' (HTTP link crawl), or 'hybrid' (both, default)."),
  max_urls: z.number().int().min(1).max(1000).optional().describe("Default 100."),
  max_depth: z.number().int().min(1).max(5).optional().describe("Crawl depth, default 2."),
  include_patterns: z
    .array(z.string())
    .max(50)
    .optional()
    .describe("Regex allowlist (search semantics); a URL must match at least one."),
  exclude_patterns: z
    .array(z.string())
    .max(50)
    .optional()
    .describe("Regex denylist, applied after include_patterns."),
  same_domain_only: z.boolean().optional().describe("Default true."),
  respect_robots: z.boolean().optional().describe("Default false."),
});

const webSearchSchema = z.object({
  query: z.string().min(1).max(512).describe("The search query."),
  category: z
    .enum(["web", "news", "images", "scholar", "patents", "maps"])
    .optional()
    .describe("Default 'web'."),
  country: z.string().max(8).optional().describe("Google 'gl' country code, e.g. 'us', 'in'."),
  locale: z.string().max(16).optional().describe("Google 'hl' language, e.g. 'en'."),
  time_filter: z
    .enum(["hour", "day", "week", "month", "year"])
    .optional()
    .describe("Restrict to results from the recent past."),
  num_results: z.number().int().min(1).max(100).optional().describe("Default 10."),
  page: z.number().int().min(1).max(10).optional().describe("Default 1."),
  location: z.string().max(128).optional().describe("Free-text location, e.g. 'Austin, Texas'."),
  autocorrect: z.boolean().optional().describe("Default true."),
  perceive_top: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe(
      "Auto-render the top-N result URLs (full page content inline). Each consumes one perceive-quota unit. Default 0.",
    ),
});

const cssFieldSchema: z.ZodType<CssField> = z.lazy(() =>
  z.object({
    name: z.string().min(1).max(128),
    type: z.enum(["text", "attribute", "html", "regex", "nested", "list", "nested_list"]),
    selector: z.string().max(1024).optional(),
    attribute: z.string().max(128).optional().describe("Required when type is 'attribute'."),
    pattern: z.string().max(1024).optional().describe("Required when type is 'regex'."),
    default: z.unknown().optional(),
    transform: z.enum(["lowercase", "uppercase", "strip"]).optional(),
    fields: z
      .array(cssFieldSchema)
      .max(64)
      .optional()
      .describe("Required (non-empty) for nested/list/nested_list. Max nesting depth 5."),
  }),
) as z.ZodType<CssField>;

const extractStructuredSchema = z.object({
  urls: z
    .array(z.string().url())
    .max(50)
    .optional()
    .describe("Explicit URLs (max 50). Provide exactly one of urls / discover_from."),
  discover_from: z
    .object({
      url: z.string().url().describe("Site to discover URLs from."),
      mode: z.enum(DISCOVER_MODES).optional().describe("Default 'hybrid'."),
      max_pages: z.number().int().min(1).max(50).optional().describe("Default 10."),
    })
    .optional()
    .describe("Discover a site's URLs first, then extract from each."),
  schema: z
    .record(z.unknown())
    .describe(
      "REQUIRED output shape: a JSON-Schema object ({type:'object',properties:{...}}) or a flat {field: 'description'} map.",
    ),
  css_schema: z
    .object({
      base_selector: z
        .string()
        .min(1)
        .max(1024)
        .describe("CSS selector matching the repeating container; one record per match."),
      fields: z.array(cssFieldSchema).min(1).max(128),
      name: z.string().max(128).optional(),
      target_field: z
        .string()
        .max(128)
        .optional()
        .describe("Top-level schema property the CSS records fill. Inferred when omitted."),
    })
    .optional()
    .describe("Optional free CSS extraction pass; fields it misses escalate to the LLM tier."),
  wait_for: z.string().max(1024).optional(),
  wait_timeout_ms: z.number().int().min(0).max(60000).optional(),
  respect_robots: z.boolean().optional(),
});

const startIngestSchema = z.object({
  mode: z
    .enum(["urls", "sitemap", "crawl"])
    .optional()
    .describe("'urls' (explicit list, default), 'sitemap', or 'crawl' (discover the site first)."),
  url: z
    .string()
    .url()
    .optional()
    .describe("Seed URL — required for sitemap/crawl mode, forbidden for urls mode."),
  urls: z
    .array(z.string().url())
    .max(1000)
    .optional()
    .describe("Explicit URLs — required for urls mode, forbidden otherwise."),
  max_pages: z.number().int().min(1).max(1000).optional().describe("Discovery cap, default 50."),
  max_depth: z.number().int().min(1).max(5).optional().describe("Default 2."),
  same_domain_only: z.boolean().optional().describe("Default true."),
  include_patterns: z.array(z.string()).max(50).optional().describe("Regex allowlist."),
  exclude_patterns: z.array(z.string()).max(50).optional().describe("Regex denylist."),
  respect_robots: z.boolean().optional(),
  wait_for: z.string().max(1024).optional(),
  wait_timeout_ms: z.number().int().min(0).max(60000).optional(),
  chunk_max_words: z
    .number()
    .int()
    .min(32)
    .max(4000)
    .optional()
    .describe("Soft cap on words per chunk, default 512."),
  chunk_sentence_overlap: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Sentences repeated between consecutive chunks, default 1."),
  webhook_url: z
    .string()
    .url()
    .optional()
    .describe("HMAC-signed completion webhook target."),
});

const ingestJobIdSchema = z.object({
  job_id: z.string().describe("Ingest job ID (ing_...)."),
});

const listSchema = z.object({
  skip: z.number().int().min(0).optional().describe("Rows to skip, default 0."),
  limit: z.number().int().min(1).max(100).optional().describe("Page size, default 20."),
});

const DIFF_MODES = ["auto", "text", "structured", "tables", "metadata"] as const;

const createWatcherSchema = z.object({
  url: z.string().url().describe("The page to monitor."),
  frequency_minutes: z
    .number()
    .int()
    .min(60)
    .max(43200)
    .optional()
    .describe("Minutes between checks, 60-43200 (hourly floor is hard). Default 60."),
  diff_mode: z.enum(DIFF_MODES).optional().describe("Diff strategy. Default 'auto'."),
  track_fields: z
    .record(z.unknown())
    .optional()
    .describe("Optional field/selector subset for the diff engine."),
  webhook_url: z.string().url().optional().describe("HMAC-signed change-notification webhook."),
  notify_email: z.boolean().optional().describe("Email the project owner on changes. Default true."),
});

const watcherIdSchema = z.object({
  watcher_id: z.string().describe("Watcher ID (wat_...)."),
});

const watcherSnapshotsSchema = z.object({
  watcher_id: z.string().describe("Watcher ID (wat_...)."),
  limit: z.number().int().min(1).max(100).optional().describe("Snapshots to return, default 20."),
});

const updateWatcherSchema = z.object({
  watcher_id: z.string().describe("Watcher ID (wat_...)."),
  frequency_minutes: z.number().int().min(60).max(43200).optional(),
  diff_mode: z.enum(DIFF_MODES).optional(),
  track_fields: z.record(z.unknown()).optional(),
  webhook_url: z
    .string()
    .optional()
    .describe("New webhook URL. Pass an empty string \"\" to remove the webhook."),
  notify_email: z.boolean().optional(),
  status: z.enum(["active", "paused"]).optional().describe("Pause or resume checking."),
});

// --------------------------------------------------------------------------
// Formatting helpers
// --------------------------------------------------------------------------

const MAX_INLINE_JSON = 8 * 1024;
const MAX_LISTED_URLS = 100;

function capJson(value: unknown): string {
  const text = JSON.stringify(value, null, 1) ?? "null";
  if (text.length <= MAX_INLINE_JSON) return text;
  return `${text.slice(0, MAX_INLINE_JSON)}\n... (truncated; full data in structuredContent)`;
}

function structured(result: unknown): Record<string, unknown> {
  return result as Record<string, unknown>;
}

function perceiveSummaryLines(r: PerceiveResult): string[] {
  const lines = [`Perceived ${r.url} — ${r.status}.`];
  if (r.urlFinal && r.urlFinal !== r.url) lines.push(`Final URL: ${r.urlFinal}`);
  if (r.cacheHit) lines.push("Served from cache.");
  for (const [name, artifact] of Object.entries(r.outputs)) {
    lines.push(
      `- ${name}: ${artifact.sizeBytes} bytes, ${artifact.contentType}, expires in ${artifact.expiresIn}s${artifact.url ? ` — ${artifact.url}` : ""}`,
    );
  }
  if (r.structured) lines.push(`Structured data:\n${capJson(r.structured)}`);
  if (r.extractionTier) lines.push(`Extraction tier: ${r.extractionTier}`);
  if (r.renderQuality !== undefined) lines.push(`Render quality: ${r.renderQuality}`);
  if (r.costCents) lines.push(`Cost: ${r.costCents} cents`);
  if (r.error) lines.push(`Error: ${r.error}`);
  if (r.warnings.length) lines.push(`Warnings: ${r.warnings.join("; ")}`);
  return lines;
}

async function perceiveResultContent(r: PerceiveResult): Promise<CallToolResult> {
  const content: ContentBlock[] = [{ type: "text", text: perceiveSummaryLines(r).join("\n") }];
  const mdUrl = r.outputs.markdown?.url ?? r.outputs.markdown_fit?.url;
  if (mdUrl) {
    const md = await fetchTextInline(mdUrl);
    if (md !== null) content.push({ type: "text", text: `--- Markdown ---\n${md}` });
  }
  return { content, structuredContent: structured(r) };
}

function batchSummary(b: PerceiveBatchResult): string {
  const lines = [
    `Perceive batch ${b.jobId}: ${b.status}.`,
    `URLs: ${b.total} total, ${b.completed} completed, ${b.failed} failed, ${b.pending} pending.`,
  ];
  if (b.status === "queued" || b.status === "processing") {
    lines.push("Poll get_perceive_batch with this job_id; allow roughly 5-30 s per URL.");
  }
  if (b.zip?.url) lines.push(`ZIP: ${b.zip.url}`);
  for (const item of b.items.slice(0, 25)) {
    lines.push(`- ${item.url}: ${item.status}${item.error ? ` (${item.error})` : ""}`);
  }
  if (b.items.length > 25) lines.push(`... and ${b.items.length - 25} more items (see structuredContent).`);
  if (b.warnings.length) lines.push(`Warnings: ${b.warnings.join("; ")}`);
  return lines.join("\n");
}

function ingestJobSummary(job: IngestJob): string {
  const lines = [
    `Ingest job ${job.jobId}: ${job.status} (mode ${job.mode}).`,
    `Pages: ${job.pagesDiscovered} discovered, ${job.pagesProcessed} processed, ${job.pagesFailed} failed. Chunks: ${job.totalChunks}.`,
  ];
  if (job.outputUrl) lines.push(`Output JSONL: ${job.outputUrl}`);
  if (job.errorMessage) lines.push(`Error: ${job.errorMessage}`);
  if (job.webhookUrl) lines.push(`Webhook: ${job.webhookUrl} (delivered: ${job.webhookDelivered})`);
  if (["queued", "discovering", "processing"].includes(job.status)) {
    lines.push("Poll get_ingest_job with this job_id; allow roughly 5-30 s per page.");
  }
  if (job.warnings.length) lines.push(`Warnings: ${job.warnings.join("; ")}`);
  return lines.join("\n");
}

function watcherSummary(w: Watcher, heading: string): string {
  const lines = [
    `${heading} ${w.watcherId}: ${w.status}.`,
    `URL: ${w.url}`,
    `Checks every ${w.frequencyMinutes} min (diff mode: ${w.diffMode}). Checks so far: ${w.checksCount}, consecutive errors: ${w.consecutiveErrors}.`,
  ];
  if (w.nextCheckAt) lines.push(`Next check: ${w.nextCheckAt}`);
  if (w.lastChangeAt) lines.push(`Last change: ${w.lastChangeAt}`);
  if (w.webhookUrl) lines.push(`Webhook: ${w.webhookUrl}`);
  lines.push(`Email notifications: ${w.notifyEmail ? "on" : "off"}`);
  return lines.join("\n");
}

type ToolExtra = { title: string; description: string };

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

export function registerV2Tools(server: McpServer, client: Enconvert): void {
  const register = <Shape extends z.ZodRawShape>(
    name: string,
    meta: ToolExtra,
    schema: z.ZodObject<Shape>,
    handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
  ): void => {
    const wrapped = async (input: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
      try {
        return await handler(input);
      } catch (e) {
        return errorResult(e);
      }
    };
    server.registerTool(
      name,
      { title: meta.title, description: meta.description, inputSchema: schema.shape },
      // The SDK's ToolCallback generic does not unify with a generic wrapper;
      // input typing is enforced above at every handler definition.
      wrapped as Parameters<typeof server.registerTool>[2],
    );
  };

  const toPerceiveOptions = (i: z.infer<typeof perceiveUrlSchema>): PerceiveOptions => {
    const o: PerceiveOptions = {};
    if (i.outputs !== undefined) o.outputs = i.outputs;
    if (i.extract !== undefined) o.extract = i.extract;
    if (i.schema !== undefined) o.schema = i.schema;
    if (i.wait_for !== undefined) o.waitFor = i.wait_for;
    if (i.wait_timeout_ms !== undefined) o.waitTimeoutMs = i.wait_timeout_ms;
    if (i.js_code !== undefined) o.jsCode = i.js_code;
    if (i.viewport_width !== undefined || i.viewport_height !== undefined) {
      o.viewport = { width: i.viewport_width, height: i.viewport_height };
    }
    if (i.cache_mode !== undefined) o.cacheMode = i.cache_mode;
    const pdf = toPdfOptions(i.pdf_options);
    if (pdf) o.pdfOptions = pdf;
    if (i.block_resources !== undefined) o.blockResources = i.block_resources;
    if (i.respect_robots !== undefined) o.respectRobots = i.respect_robots;
    if (i.mobile !== undefined) o.mobile = i.mobile;
    return o;
  };

  // -- perceive --
  register("perceive_url", { title: PERCEIVE_URL_TITLE, description: PERCEIVE_URL_DESCRIPTION }, perceiveUrlSchema, async (input) => {
    const result = await client.v2.perceive(input.url, toPerceiveOptions(input));
    return perceiveResultContent(result);
  });

  register(
    "get_perceive_operation",
    { title: GET_PERCEIVE_OPERATION_TITLE, description: GET_PERCEIVE_OPERATION_DESCRIPTION },
    operationIdSchema,
    async (input) => {
      const result = await client.v2.getPerceiveOperation(input.operation_id);
      return perceiveResultContent(result);
    },
  );

  register("perceive_batch", { title: PERCEIVE_BATCH_TITLE, description: PERCEIVE_BATCH_DESCRIPTION }, perceiveBatchSchema, async (input) => {
    const { urls, output_mode, ...rest } = input;
    const result = await client.v2.perceiveBatch(urls, {
      ...toPerceiveOptions({ ...rest, url: "" } as z.infer<typeof perceiveUrlSchema>),
      outputMode: output_mode,
    });
    return { content: [{ type: "text", text: batchSummary(result) }], structuredContent: structured(result) };
  });

  register(
    "get_perceive_batch",
    { title: GET_PERCEIVE_BATCH_TITLE, description: GET_PERCEIVE_BATCH_DESCRIPTION },
    batchJobIdSchema,
    async (input) => {
      const result = await client.v2.getPerceiveBatch(input.job_id);
      return { content: [{ type: "text", text: batchSummary(result) }], structuredContent: structured(result) };
    },
  );

  // -- discover --
  register("discover_urls", { title: DISCOVER_URLS_TITLE, description: DISCOVER_URLS_DESCRIPTION }, discoverSchema, async (input) => {
    const result = await client.v2.discover(input.url, {
      mode: input.mode,
      maxUrls: input.max_urls,
      maxDepth: input.max_depth,
      includePatterns: input.include_patterns,
      excludePatterns: input.exclude_patterns,
      sameDomainOnly: input.same_domain_only,
      respectRobots: input.respect_robots,
    });
    const lines = [
      `Discovered ${result.total} URLs on ${result.url} (mode: ${result.mode}${result.truncated ? ", truncated by max_urls" : ""}).`,
      `Sources: ${JSON.stringify(result.sources)}. Pages crawled: ${result.pagesCrawled}.`,
      ...result.urls.slice(0, MAX_LISTED_URLS).map((u) => `- ${u}`),
    ];
    if (result.urls.length > MAX_LISTED_URLS) {
      lines.push(`... and ${result.urls.length - MAX_LISTED_URLS} more (see structuredContent.urls).`);
    }
    if (result.warnings.length) lines.push(`Warnings: ${result.warnings.join("; ")}`);
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured(result) };
  });

  // -- web search --
  register("web_search", { title: WEB_SEARCH_TITLE, description: WEB_SEARCH_DESCRIPTION }, webSearchSchema, async (input) => {
    const result = await client.v2.lookup(input.query, {
      category: input.category,
      country: input.country,
      locale: input.locale,
      timeFilter: input.time_filter,
      numResults: input.num_results,
      page: input.page,
      location: input.location,
      autocorrect: input.autocorrect,
      perceiveTop: input.perceive_top,
    });
    const lines = [`${result.total} results for "${result.query}" (${result.category}).`];
    if (result.answerBox) lines.push(`Answer box:\n${capJson(result.answerBox)}`);
    result.results.forEach((hit, i) => {
      const snippet = hit.snippet ? ` — ${hit.snippet.slice(0, 200)}` : "";
      lines.push(`${i + 1}. ${hit.title ?? "(untitled)"} — ${hit.url ?? ""}${snippet}`);
      if (hit.perceive) lines.push(`   (perceived: operation ${hit.perceive.operationId}, artifacts in structuredContent)`);
    });
    if (result.perceiveTop > 0) {
      lines.push(`Perceived top ${result.perceiveTop} result(s); full page artifacts are in structuredContent.results[i].perceive.`);
    }
    if (result.warnings.length) lines.push(`Warnings: ${result.warnings.join("; ")}`);
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured(result) };
  });

  // -- distill --
  register(
    "extract_structured",
    { title: EXTRACT_STRUCTURED_TITLE, description: EXTRACT_STRUCTURED_DESCRIPTION },
    extractStructuredSchema,
    async (input) => {
      const result = await client.v2.distill({
        urls: input.urls,
        discoverFrom: input.discover_from
          ? { url: input.discover_from.url, mode: input.discover_from.mode, maxPages: input.discover_from.max_pages }
          : undefined,
        schema: input.schema,
        cssSchema: input.css_schema
          ? {
              baseSelector: input.css_schema.base_selector,
              fields: input.css_schema.fields,
              name: input.css_schema.name,
              targetField: input.css_schema.target_field,
            }
          : undefined,
        waitFor: input.wait_for,
        waitTimeoutMs: input.wait_timeout_ms,
        respectRobots: input.respect_robots,
      });
      const lines = [
        `Extraction ${result.operationId}: ${result.completed}/${result.total} URLs completed, ${result.failed} failed. Total cost: ${result.totalCostCents} cents.`,
      ];
      for (const item of result.results) {
        lines.push(`\n${item.url} — ${item.status} (tier: ${item.extractionTier}, css: ${item.fieldsFromCss}, llm: ${item.fieldsFromLlm})`);
        if (item.data) lines.push(capJson(item.data));
        if (item.error) lines.push(`Error: ${item.error}`);
      }
      if (result.warnings.length) lines.push(`Warnings: ${result.warnings.join("; ")}`);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured(result) };
    },
  );

  // -- ingest --
  register("start_ingest", { title: START_INGEST_TITLE, description: START_INGEST_DESCRIPTION }, startIngestSchema, async (input) => {
    const chunk =
      input.chunk_max_words !== undefined || input.chunk_sentence_overlap !== undefined
        ? { maxWords: input.chunk_max_words, sentenceOverlap: input.chunk_sentence_overlap }
        : undefined;
    const job = await client.v2.ingest({
      mode: input.mode,
      url: input.url,
      urls: input.urls,
      maxPages: input.max_pages,
      maxDepth: input.max_depth,
      sameDomainOnly: input.same_domain_only,
      includePatterns: input.include_patterns,
      excludePatterns: input.exclude_patterns,
      respectRobots: input.respect_robots,
      waitFor: input.wait_for,
      waitTimeoutMs: input.wait_timeout_ms,
      chunk,
      webhookUrl: input.webhook_url,
    });
    return { content: [{ type: "text", text: ingestJobSummary(job) }], structuredContent: structured(job) };
  });

  register("list_ingest_jobs", { title: LIST_INGEST_JOBS_TITLE, description: LIST_INGEST_JOBS_DESCRIPTION }, listSchema, async (input) => {
    const result = await client.v2.listIngestJobs({ skip: input.skip, limit: input.limit });
    const lines = [`${result.jobs.length} ingest job(s) (skip ${result.skip}, limit ${result.limit}, more: ${result.hasMore}).`];
    for (const job of result.jobs) {
      lines.push(
        `- ${job.jobId}: ${job.status} (${job.mode}) — ${job.pagesProcessed}/${job.pagesDiscovered} pages, ${job.totalChunks} chunks${job.outputUrl ? ", output ready" : ""}`,
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured(result) };
  });

  register("get_ingest_job", { title: GET_INGEST_JOB_TITLE, description: GET_INGEST_JOB_DESCRIPTION }, ingestJobIdSchema, async (input) => {
    const job = await client.v2.getIngestJob(input.job_id);
    return { content: [{ type: "text", text: ingestJobSummary(job) }], structuredContent: structured(job) };
  });

  register(
    "cancel_ingest_job",
    { title: CANCEL_INGEST_JOB_TITLE, description: CANCEL_INGEST_JOB_DESCRIPTION },
    ingestJobIdSchema,
    async (input) => {
      const job = await client.v2.cancelIngestJob(input.job_id);
      return { content: [{ type: "text", text: ingestJobSummary(job) }], structuredContent: structured(job) };
    },
  );

  register(
    "retry_ingest_webhook",
    { title: RETRY_INGEST_WEBHOOK_TITLE, description: RETRY_INGEST_WEBHOOK_DESCRIPTION },
    ingestJobIdSchema,
    async (input) => {
      const result = await client.v2.retryIngestWebhook(input.job_id);
      const text = `Webhook redelivery for ${result.jobId}: ${result.delivered ? "delivered" : "NOT delivered"} after ${result.attempts} attempt(s)${result.statusCode !== undefined ? ` (last status ${result.statusCode})` : ""}. ${result.detail}`;
      return { content: [{ type: "text", text }], structuredContent: structured(result) };
    },
  );

  // -- watch --
  register("create_watcher", { title: CREATE_WATCHER_TITLE, description: CREATE_WATCHER_DESCRIPTION }, createWatcherSchema, async (input) => {
    const watcher = await client.v2.createWatcher(input.url, {
      frequencyMinutes: input.frequency_minutes,
      diffMode: input.diff_mode,
      trackFields: input.track_fields,
      webhookUrl: input.webhook_url,
      notifyEmail: input.notify_email,
    });
    return { content: [{ type: "text", text: watcherSummary(watcher, "Created watcher") }], structuredContent: structured(watcher) };
  });

  register("list_watchers", { title: LIST_WATCHERS_TITLE, description: LIST_WATCHERS_DESCRIPTION }, listSchema, async (input) => {
    const result = await client.v2.listWatchers({ skip: input.skip, limit: input.limit });
    const lines = [`${result.watchers.length} watcher(s) (skip ${result.skip}, limit ${result.limit}, more: ${result.hasMore}).`];
    for (const w of result.watchers) {
      lines.push(`- ${w.watcherId}: ${w.status}, every ${w.frequencyMinutes} min — ${w.url} (checks: ${w.checksCount}, errors: ${w.consecutiveErrors})`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured(result) };
  });

  register("get_watcher", { title: GET_WATCHER_TITLE, description: GET_WATCHER_DESCRIPTION }, watcherIdSchema, async (input) => {
    const watcher = await client.v2.getWatcher(input.watcher_id);
    return { content: [{ type: "text", text: watcherSummary(watcher, "Watcher") }], structuredContent: structured(watcher) };
  });

  register(
    "get_watcher_snapshots",
    { title: GET_WATCHER_SNAPSHOTS_TITLE, description: GET_WATCHER_SNAPSHOTS_DESCRIPTION },
    watcherSnapshotsSchema,
    async (input) => {
      const result = await client.v2.getWatcherSnapshots(input.watcher_id, { limit: input.limit });
      const lines = [`${result.snapshots.length} snapshot(s) for ${result.watcherId} (newest first).`];
      for (const s of result.snapshots) {
        lines.push(
          `- ${s.checkedAt}: ${s.hasChanges ? `${s.changeCount} change(s)` : "no changes"}${s.similarity !== undefined ? `, similarity ${s.similarity}` : ""}`,
        );
        if (s.hasChanges && s.changes.length) lines.push(`  ${capJson(s.changes)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured(result) };
    },
  );

  register("update_watcher", { title: UPDATE_WATCHER_TITLE, description: UPDATE_WATCHER_DESCRIPTION }, updateWatcherSchema, async (input) => {
    const watcher = await client.v2.updateWatcher(input.watcher_id, {
      frequencyMinutes: input.frequency_minutes,
      diffMode: input.diff_mode,
      trackFields: input.track_fields,
      webhookUrl: input.webhook_url,
      notifyEmail: input.notify_email,
      status: input.status,
    });
    return { content: [{ type: "text", text: watcherSummary(watcher, "Updated watcher") }], structuredContent: structured(watcher) };
  });

  register("delete_watcher", { title: DELETE_WATCHER_TITLE, description: DELETE_WATCHER_DESCRIPTION }, watcherIdSchema, async (input) => {
    const watcher = await client.v2.deleteWatcher(input.watcher_id);
    return {
      content: [{ type: "text", text: `Watcher ${watcher.watcherId} deleted (monitoring stopped).` }],
      structuredContent: structured(watcher),
    };
  });
}
