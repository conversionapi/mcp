/** Helpers shared by the V1 conversion tools and the V2 tool set. */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  APIError,
  AuthenticationError,
  QuotaError,
  RateLimitError,
  type PdfOptions,
} from "@enconvert/node-sdk";

export type ContentBlock = CallToolResult["content"][number];

export const INLINE_TEXT_MAX_BYTES = 256 * 1024;

export const pdfOptionsSchema = z
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

export function toPdfOptions(raw?: z.infer<typeof pdfOptionsSchema>): PdfOptions | undefined {
  if (!raw) return undefined;
  const out: PdfOptions = {};
  if (raw.page_size !== undefined) out.pageSize = raw.page_size;
  if (raw.orientation !== undefined) out.orientation = raw.orientation;
  if (raw.margins !== undefined) out.margins = raw.margins;
  if (raw.scale !== undefined) out.scale = raw.scale;
  if (raw.grayscale !== undefined) out.grayscale = raw.grayscale;
  return out;
}

/** Fetch a small text artifact for inline return; null when too big/unavailable. */
export async function fetchTextInline(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > INLINE_TEXT_MAX_BYTES) return null;
    return new TextDecoder("utf-8").decode(buf);
  } catch {
    return null;
  }
}

export function errorResult(e: unknown): CallToolResult {
  if (e instanceof AuthenticationError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Authentication failed: ${e.message}\n\nSet ENCONVERT_API_KEY to a valid key. Get one at https://enconvert.com/dashboard/api-keys. Note: V2 tools require a PRIVATE API key.`,
        },
      ],
    };
  }
  if (e instanceof QuotaError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Plan or quota gate: ${e.message}\n\nThis feature is not enabled on the current Enconvert plan or its monthly quota is exhausted. Upgrade the plan or wait for the quota reset — retrying now will not succeed.`,
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
  return { isError: true, content: [{ type: "text", text: `Request failed: ${msg}` }] };
}
