/**
 * MCP server construction: one McpServer, five registered tools.
 *
 * Tools wrap the `@enconvert/node-sdk` client (which owns all HTTP, auth, timeout,
 * and job_id polling-on-500 logic). Each handler maps MCP snake_case input
 * to SDK camelCase options, invokes the SDK, and returns a consistent
 * tri-modal response: text summary + structuredContent + optional
 * resource_link when the output was saved locally.
 */

import { basename, isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  APIError,
  AuthenticationError,
  Enconvert,
  RateLimitError,
  type ConversionResult,
  type FileInput,
  type PdfOptions,
} from "@enconvert/node-sdk";
import { z } from "zod";

import {
  CONVERT_DOCUMENT_DESCRIPTION,
  CONVERT_DOCUMENT_TITLE,
  CONVERT_IMAGE_DESCRIPTION,
  CONVERT_IMAGE_TITLE,
  URL_TO_MARKDOWN_DESCRIPTION,
  URL_TO_MARKDOWN_TITLE,
  URL_TO_PDF_DESCRIPTION,
  URL_TO_PDF_TITLE,
  URL_TO_SCREENSHOT_DESCRIPTION,
  URL_TO_SCREENSHOT_TITLE,
} from "./descriptions.js";

const SERVER_VERSION = "0.1.0";
const INLINE_MARKDOWN_MAX_BYTES = 256 * 1024;

export interface Env {
  apiKey: string;
  baseUrl?: string;
}

// --------------------------------------------------------------------------
// Schemas — every field has .describe() so the LLM sees its purpose.
// --------------------------------------------------------------------------

const pdfOptionsSchema = z
  .object({
    page_size: z
      .string()
      .optional()
      .describe("Page size preset, e.g. 'A4', 'Letter', 'Legal'. Ignored when single_page is true."),
    orientation: z
      .enum(["portrait", "landscape"])
      .optional()
      .describe("Page orientation. Ignored when single_page is true."),
    margins: z
      .object({
        top: z.number().optional(),
        bottom: z.number().optional(),
        left: z.number().optional(),
        right: z.number().optional(),
      })
      .optional()
      .describe("PDF margins in inches."),
    scale: z.number().min(0.1).max(2).optional().describe("Page scale factor between 0.1 and 2.0."),
    grayscale: z.boolean().optional().describe("Render the PDF in grayscale."),
  })
  .describe("Optional PDF rendering options.");

const urlToPdfSchema = z.object({
  url: z.string().url().describe("The full http(s) URL of the web page to convert."),
  save_to: z
    .string()
    .optional()
    .describe(
      "Optional absolute local path to also save the PDF. If omitted, only the presigned download URL is returned.",
    ),
  single_page: z
    .boolean()
    .optional()
    .describe(
      "Render the whole page as one continuous (un-paginated) PDF page. Default: true. Set false to get a standard multi-page paginated PDF.",
    ),
  viewport_width: z
    .number()
    .int()
    .min(320)
    .max(3840)
    .optional()
    .describe("Browser viewport width in pixels. Default: 1920."),
  viewport_height: z
    .number()
    .int()
    .min(320)
    .max(3840)
    .optional()
    .describe("Browser viewport height in pixels. Default: 1080."),
  load_media: z
    .boolean()
    .optional()
    .describe("Wait for images and videos to load before capture. Default: true."),
  enable_scroll: z
    .boolean()
    .optional()
    .describe("Scroll the page to trigger lazy-loaded content before capture. Default: true."),
  pdf_options: pdfOptionsSchema.optional(),
  output_filename: z
    .string()
    .optional()
    .describe("Desired output filename (without extension)."),
});

const urlToScreenshotSchema = z.object({
  url: z.string().url().describe("The full http(s) URL of the web page to capture."),
  save_to: z
    .string()
    .optional()
    .describe("Optional absolute local path to also save the PNG file."),
  viewport_width: z
    .number()
    .int()
    .min(320)
    .max(3840)
    .optional()
    .describe("Browser viewport width in pixels. Default: 1920."),
  viewport_height: z
    .number()
    .int()
    .min(320)
    .max(3840)
    .optional()
    .describe("Browser viewport height in pixels. Default: 1080."),
  load_media: z
    .boolean()
    .optional()
    .describe("Wait for images and videos to load before capture. Default: true."),
  enable_scroll: z
    .boolean()
    .optional()
    .describe("Scroll the page to trigger lazy-loaded content before capture. Default: true."),
  output_filename: z
    .string()
    .optional()
    .describe("Desired output filename (without extension)."),
});

const urlToMarkdownSchema = z.object({
  url: z.string().url().describe("The full http(s) URL of the article or web page to convert."),
  save_to: z
    .string()
    .optional()
    .describe("Optional absolute local path to also save the .md file."),
  viewport_width: z.number().int().min(320).max(3840).optional().describe("Viewport width. Default: 1920."),
  viewport_height: z
    .number()
    .int()
    .min(320)
    .max(3840)
    .optional()
    .describe("Viewport height. Default: 1080."),
  load_media: z.boolean().optional().describe("Wait for media to load. Default: true."),
  enable_scroll: z
    .boolean()
    .optional()
    .describe("Scroll to trigger lazy content. Default: true."),
  output_filename: z.string().optional().describe("Desired output filename (without extension)."),
});

const convertDocumentSchema = z.object({
  file: z
    .string()
    .describe(
      "Absolute local filesystem path to the document, OR an http(s):// URL. Relative paths are rejected — always pass an absolute path.",
    ),
  output_format: z
    .string()
    .default("pdf")
    .describe(
      "Target format (e.g. 'pdf', 'docx', 'json', 'yaml', 'csv'). Defaults to 'pdf'.",
    ),
  save_to: z
    .string()
    .optional()
    .describe("Optional absolute local path to also save the converted file."),
  output_filename: z
    .string()
    .optional()
    .describe("Desired output filename (without extension)."),
  pdf_options: pdfOptionsSchema.optional(),
});

const convertImageSchema = z.object({
  file: z
    .string()
    .describe(
      "Absolute local filesystem path to the image, OR an http(s):// URL. Relative paths are rejected — always pass an absolute path.",
    ),
  output_format: z
    .enum(["jpeg", "png", "svg", "heic", "webp"])
    .describe("Target image format."),
  save_to: z
    .string()
    .optional()
    .describe("Optional absolute local path to also save the converted image."),
  output_filename: z
    .string()
    .optional()
    .describe("Desired output filename (without extension)."),
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function resolveFileInput(input: string): Promise<FileInput> {
  if (/^https?:\/\//i.test(input)) {
    const resp = await fetch(input);
    if (!resp.ok) {
      throw new Error(`Failed to fetch file from URL (${resp.status}): ${resp.statusText}`);
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const urlPath = new URL(input).pathname;
    const name = basename(urlPath) || "download.bin";
    const contentType = resp.headers.get("content-type")?.split(";")[0]?.trim();
    return { data: bytes, filename: name, contentType: contentType || undefined };
  }
  if (!isAbsolute(input)) {
    throw new Error(
      `'file' must be an absolute path or http(s):// URL. Got a relative path: '${input}'. This MCP server has no intuitive working directory — pass the full path.`,
    );
  }
  return input;
}

function toPdfOptions(raw?: z.infer<typeof pdfOptionsSchema>): PdfOptions | undefined {
  if (!raw) return undefined;
  const out: PdfOptions = {};
  if (raw.page_size !== undefined) out.pageSize = raw.page_size;
  if (raw.orientation !== undefined) out.orientation = raw.orientation;
  if (raw.margins !== undefined) out.margins = raw.margins;
  if (raw.scale !== undefined) out.scale = raw.scale;
  if (raw.grayscale !== undefined) out.grayscale = raw.grayscale;
  return out;
}

interface StructuredPayload {
  presignedUrl: string;
  objectKey: string;
  filename: string;
  fileSize?: number;
  conversionTimeSeconds?: number;
  savedTo?: string;
  markdown?: string;
}

function buildStructured(result: ConversionResult, savedTo?: string): StructuredPayload {
  const payload: StructuredPayload = {
    presignedUrl: result.presignedUrl,
    objectKey: result.objectKey,
    filename: result.filename,
  };
  if (result.fileSize !== undefined) payload.fileSize = result.fileSize;
  if (result.conversionTimeSeconds !== undefined) {
    payload.conversionTimeSeconds = result.conversionTimeSeconds;
  }
  if (savedTo) payload.savedTo = savedTo;
  return payload;
}

function summaryText(kind: string, result: ConversionResult, savedTo?: string): string {
  const parts = [
    `${kind} ready.`,
    `Filename: ${result.filename}`,
    `Download URL: ${result.presignedUrl}`,
  ];
  if (result.fileSize !== undefined) parts.push(`Size: ${result.fileSize} bytes`);
  if (result.conversionTimeSeconds !== undefined) {
    parts.push(`Conversion time: ${result.conversionTimeSeconds.toFixed(2)}s`);
  }
  if (savedTo) parts.push(`Saved locally to: ${savedTo}`);
  return parts.join("\n");
}

type ContentBlock = CallToolResult["content"][number];

function okResult(
  kind: string,
  result: ConversionResult,
  savedTo: string | undefined,
  mimeType: string,
  extraContent: ContentBlock[] = [],
): CallToolResult {
  const content: ContentBlock[] = [
    { type: "text", text: summaryText(kind, result, savedTo) },
    ...extraContent,
  ];
  if (savedTo) {
    content.push({
      type: "resource_link",
      uri: `file://${savedTo.replace(/\\/g, "/")}`,
      name: result.filename,
      mimeType,
      description: `Locally saved ${kind}.`,
    });
  }
  const structured = buildStructured(result, savedTo) as unknown as Record<string, unknown>;
  return { content, structuredContent: structured };
}

function errorResult(e: unknown): CallToolResult {
  if (e instanceof AuthenticationError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Authentication failed: ${e.message}\n\nSet ENCONVERT_API_KEY to a valid key. Get one at https://enconvert.com/dashboard/api-keys.`,
        },
      ],
    };
  }
  if (e instanceof RateLimitError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Rate limit reached: ${e.message}\n\nWait a moment and retry, or upgrade your Enconvert plan.`,
        },
      ],
    };
  }
  if (e instanceof APIError) {
    return {
      isError: true,
      content: [{ type: "text", text: `Enconvert API error (${e.statusCode}): ${e.message}` }],
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text", text: `Conversion failed: ${msg}` }] };
}

// --------------------------------------------------------------------------
// createServer
// --------------------------------------------------------------------------

export function createServer(env: Env): McpServer {
  const client = new Enconvert({ apiKey: env.apiKey, baseUrl: env.baseUrl });

  const server = new McpServer({
    name: "enconvert",
    version: SERVER_VERSION,
  });

  // -- convert_url_to_pdf --
  server.registerTool(
    "convert_url_to_pdf",
    {
      title: URL_TO_PDF_TITLE,
      description: URL_TO_PDF_DESCRIPTION,
      inputSchema: urlToPdfSchema.shape,
    },
    async (input) => {
      try {
        const result = await client.convertUrlToPdf(input.url, {
          saveTo: input.save_to,
          singlePage: input.single_page,
          viewportWidth: input.viewport_width,
          viewportHeight: input.viewport_height,
          loadMedia: input.load_media,
          enableScroll: input.enable_scroll,
          pdfOptions: toPdfOptions(input.pdf_options),
          outputFilename: input.output_filename,
        });
        return okResult("PDF", result, input.save_to, "application/pdf");
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // -- convert_url_to_screenshot --
  server.registerTool(
    "convert_url_to_screenshot",
    {
      title: URL_TO_SCREENSHOT_TITLE,
      description: URL_TO_SCREENSHOT_DESCRIPTION,
      inputSchema: urlToScreenshotSchema.shape,
    },
    async (input) => {
      try {
        const result = await client.convertUrlToScreenshot(input.url, {
          saveTo: input.save_to,
          viewportWidth: input.viewport_width,
          viewportHeight: input.viewport_height,
          loadMedia: input.load_media,
          enableScroll: input.enable_scroll,
          outputFilename: input.output_filename,
        });
        return okResult("Screenshot", result, input.save_to, "image/png");
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // -- convert_url_to_markdown --
  server.registerTool(
    "convert_url_to_markdown",
    {
      title: URL_TO_MARKDOWN_TITLE,
      description: URL_TO_MARKDOWN_DESCRIPTION,
      inputSchema: urlToMarkdownSchema.shape,
    },
    async (input) => {
      try {
        const result = await client.convertUrlToMarkdown(input.url, {
          saveTo: input.save_to,
          viewportWidth: input.viewport_width,
          viewportHeight: input.viewport_height,
          loadMedia: input.load_media,
          enableScroll: input.enable_scroll,
          outputFilename: input.output_filename,
        });

        // Inline the markdown body when it's under the size cap.
        const extras: ContentBlock[] = [];
        try {
          const resp = await fetch(result.presignedUrl);
          if (resp.ok) {
            const buf = new Uint8Array(await resp.arrayBuffer());
            if (buf.byteLength <= INLINE_MARKDOWN_MAX_BYTES) {
              const md = new TextDecoder("utf-8").decode(buf);
              extras.push({
                type: "text",
                text: `--- Extracted Markdown ---\n${md}`,
              });
            }
          }
        } catch {
          // Non-fatal: inline fetch is a best-effort convenience.
        }
        return okResult("Markdown", result, input.save_to, "text/markdown", extras);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // -- convert_document --
  server.registerTool(
    "convert_document",
    {
      title: CONVERT_DOCUMENT_TITLE,
      description: CONVERT_DOCUMENT_DESCRIPTION,
      inputSchema: convertDocumentSchema.shape,
    },
    async (input) => {
      try {
        const fileInput = await resolveFileInput(input.file);
        const result = await client.convertDocument(fileInput, {
          outputFormat: input.output_format,
          saveTo: input.save_to,
          outputFilename: input.output_filename,
          pdfOptions: toPdfOptions(input.pdf_options),
        });
        const mime = mimeForExtension(input.output_format);
        return okResult("Document", result, input.save_to, mime);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // -- convert_image --
  server.registerTool(
    "convert_image",
    {
      title: CONVERT_IMAGE_TITLE,
      description: CONVERT_IMAGE_DESCRIPTION,
      inputSchema: convertImageSchema.shape,
    },
    async (input) => {
      try {
        const fileInput = await resolveFileInput(input.file);
        const result = await client.convertImage(fileInput, {
          outputFormat: input.output_format,
          saveTo: input.save_to,
          outputFilename: input.output_filename,
        });
        const mime = mimeForImageFormat(input.output_format);
        return okResult("Image", result, input.save_to, mime);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

function mimeForExtension(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  const map: Record<string, string> = {
    pdf: "application/pdf",
    html: "text/html",
    htm: "text/html",
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    yaml: "application/x-yaml",
    yml: "application/x-yaml",
    toml: "application/toml",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    epub: "application/epub+zip",
  };
  return map[e] || "application/octet-stream";
}

function mimeForImageFormat(fmt: string): string {
  const map: Record<string, string> = {
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    heic: "image/heic",
    webp: "image/webp",
  };
  return map[fmt.toLowerCase()] || "application/octet-stream";
}
