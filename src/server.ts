/**
 * MCP server construction.
 *
 * V1 tools cover FILE conversions only (convert_document, convert_image,
 * get_job_status), wrapping the `@enconvert/node-sdk` client (which owns
 * all HTTP, auth, timeout, and job_id polling-on-500 logic). Browser-based
 * URL work (render, screenshot, markdown, whole-site) lives exclusively in
 * the V2 tool set — see v2-tools.ts (perceive_url and friends).
 *
 * Each handler maps MCP snake_case input to SDK camelCase options, invokes
 * the SDK, and returns a consistent tri-modal response: text summary +
 * structuredContent + optional resource_link when the output was saved
 * locally.
 */

import { basename, isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  Enconvert,
  type ConversionResult,
  type FileInput,
  type JobStatus,
} from "@enconvert/node-sdk";
import { z } from "zod";

import {
  errorResult,
  pdfOptionsSchema,
  toPdfOptions,
  type ContentBlock,
} from "./shared.js";
import { instrumentServer } from "./analytics.js";
import { registerV2Tools } from "./v2-tools.js";

import {
  CONVERT_DOCUMENT_DESCRIPTION,
  CONVERT_DOCUMENT_TITLE,
  CONVERT_IMAGE_DESCRIPTION,
  CONVERT_IMAGE_TITLE,
  JOB_STATUS_DESCRIPTION,
  JOB_STATUS_TITLE,
} from "./descriptions.js";

const SERVER_VERSION = "0.2.0";

export interface Env {
  apiKey: string;
  baseUrl?: string;
}

// --------------------------------------------------------------------------
// Schemas — every field has .describe() so the LLM sees its purpose.
// --------------------------------------------------------------------------

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
      "Absolute local filesystem path to the image (or a .pdf to rasterize), OR an http(s):// URL. Relative paths are rejected — always pass an absolute path.",
    ),
  output_format: z
    .enum(["jpeg", "png", "svg", "heic", "webp"])
    .describe("Target image format. PDF input supports 'jpeg' only."),
  save_to: z
    .string()
    .optional()
    .describe("Optional absolute local path to also save the converted image."),
  output_filename: z
    .string()
    .optional()
    .describe("Desired output filename (without extension)."),
});

const jobStatusSchema = z.object({
  job_id: z
    .string()
    .describe("Job ID (jobId) returned by a previous conversion call."),
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

interface StructuredPayload {
  presignedUrl: string;
  objectKey: string;
  filename: string;
  fileSize?: number;
  conversionTimeSeconds?: number;
  jobId?: string;
  savedTo?: string;
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
  if (result.jobId) payload.jobId = result.jobId;
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
  if (result.jobId) parts.push(`Job ID: ${result.jobId}`);
  if (savedTo) parts.push(`Saved locally to: ${savedTo}`);
  return parts.join("\n");
}

function jobStatusResult(jobId: string, status: JobStatus): CallToolResult {
  const parts = [`Job ${jobId}: ${status.status}.`];
  if (status.presignedUrl) parts.push(`Download URL: ${status.presignedUrl}`);
  if (status.error) parts.push(`Error: ${status.error}`);
  if (status.status === "processing") parts.push("Still processing — poll again shortly.");
  return {
    content: [{ type: "text", text: parts.join("\n") }],
    structuredContent: { ...status } as unknown as Record<string, unknown>,
  };
}

function okResult(
  kind: string,
  result: ConversionResult,
  savedTo: string | undefined,
  mimeType: string,
): CallToolResult {
  const content: ContentBlock[] = [
    { type: "text", text: summaryText(kind, result, savedTo) },
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

// --------------------------------------------------------------------------
// createServer
// --------------------------------------------------------------------------

export function createServer(env: Env): McpServer {
  const client = new Enconvert({ apiKey: env.apiKey, baseUrl: env.baseUrl });

  const server = new McpServer({
    name: "enconvert",
    version: SERVER_VERSION,
  });

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

  // -- get_job_status --
  server.registerTool(
    "get_job_status",
    {
      title: JOB_STATUS_TITLE,
      description: JOB_STATUS_DESCRIPTION,
      inputSchema: jobStatusSchema.shape,
    },
    async (input) => {
      try {
        const status = await client.getJobStatus(input.job_id);
        return jobStatusResult(input.job_id, status);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // V2 tools (perceive / discover / search / distill / ingest / watch).
  registerV2Tools(server, client);

  // Instrument LAST: the SDK lazily installs its own CallToolRequestSchema
  // handler on the first registerTool() call above, so patching before that
  // would be overwritten rather than wrapped.
  instrumentServer(server, env, SERVER_VERSION);

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
