/**
 * PostHog instrumentation for the MCP server.
 *
 * The MCP client/server handshake gives us no human identity — every call
 * on this transport is really "the API key acting as a machine", so we
 * identify by a hash of the key rather than by any account concept. We
 * never send the raw key itself (it is a live secret, not an analytics
 * property): distinctId = "key_" + sha256(apiKey) prefix.
 *
 * Group/project attribution (groups: { project: projectId }) IS wired up
 * here: resolveProjectId() resolves the API key to a project_id via a
 * lightweight GET {baseUrl}/v1/whoami round trip, fired eagerly at the top
 * of instrumentServer() so it overlaps the MCP handshake instead of adding
 * latency to the first tool call. The group key is "project", matching
 * api/gateway/monitoring/posthog_client.py's group_of() shape, so MCP
 * traffic joins the same project-level cohorts as gateway traffic.
 *
 * beforeSend redacts tool call arguments and results before they leave the
 * process: this server's entire surface is "read/write arbitrary local
 * files and arbitrary URLs", so tool params/results routinely carry local
 * file paths, presigned S3 URLs, and page content that can contain emails.
 * The @posthog/mcp SDK does its own sanitization (binary stubs, sensitive
 * key masking), but that is generic and not tuned to this server's file/
 * URL-shaped payloads, so we scrub on top of it rather than relying on it
 * alone.
 */

import { instrument } from "@posthog/mcp";
import { PostHog } from "posthog-node";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  analyticsDisabled,
  distinctIdForApiKey,
  keyType,
  POSTHOG_HOST,
  POSTHOG_PROJECT_TOKEN,
} from "./posthog-identity.js";
import type { Env } from "./server.js";
import { DEFAULT_BASE_URL } from "./cli/validate.js";

// --------------------------------------------------------------------------
// Client — constructed once at module scope.
// --------------------------------------------------------------------------

export const posthog: PostHog | null =
  !analyticsDisabled() && POSTHOG_PROJECT_TOKEN
    ? new PostHog(POSTHOG_PROJECT_TOKEN, { host: POSTHOG_HOST })
    : null;

// --------------------------------------------------------------------------
// Project group resolution — GET /v1/whoami, best-effort, never blocking.
// --------------------------------------------------------------------------

const WHOAMI_TIMEOUT_MS = 3000;

/**
 * Resolves env.apiKey to a gateway project_id, or null on any failure
 * (401/403/404/5xx/network error/timeout). Memoized per env so repeated
 * identify() calls within one server lifetime don't re-fetch.
 */
const projectIdCache = new WeakMap<Env, Promise<string | null>>();

function fetchProjectId(env: Env): Promise<string | null> {
  const base = (env.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WHOAMI_TIMEOUT_MS);
  return fetch(`${base}/v1/whoami`, {
    method: "GET",
    headers: { "X-API-Key": env.apiKey },
    signal: ctrl.signal,
  })
    .then(async (resp) => {
      if (!resp.ok) return null;
      const data = (await resp.json()) as { project_id?: string | number };
      return data.project_id !== undefined ? String(data.project_id) : null;
    })
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

function resolveProjectId(env: Env): Promise<string | null> {
  let cached = projectIdCache.get(env);
  if (!cached) {
    cached = fetchProjectId(env);
    projectIdCache.set(env, cached);
  }
  return cached;
}

// --------------------------------------------------------------------------
// Redaction — scoped to tool call parameters/results only, so exception
// stack traces and event metadata (tool name, duration, etc.) stay intact
// for debugging.
// --------------------------------------------------------------------------

// Key names that are always redacted outright, regardless of content —
// these fields exist specifically to carry a path/URL/filename.
const SENSITIVE_KEY_PATTERN = /(file|path|url|filename|object_?key|presigned|save_?to|s3|bucket)/i;

// Any http(s) URL, including signed S3/DO Spaces URLs with query-string tokens.
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

// Absolute filesystem paths: unix (>=2 path separators, to avoid catching
// mime types like "text/html") and Windows drive-letter paths.
const ABS_PATH_PATTERN = /\/(?:[^\s"'<>]+\/)+[^\s"'<>]*|[A-Za-z]:\\[^\s"'<>]+/g;

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/gi;

function scrubString(value: string): string {
  return value
    .replace(URL_PATTERN, "[redacted-url]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(ABS_PATH_PATTERN, "[redacted-path]");
}

function redactDeep(value: unknown, keyHint?: string): unknown {
  if (typeof value === "string") {
    if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) return "[redacted]";
    return scrubString(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, keyHint));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, k);
    }
    return out;
  }
  return value;
}

type PostHogEvent = Record<string, unknown>;

function redactToolEvent(event: PostHogEvent | null | undefined): PostHogEvent | null | undefined {
  if (!event) return event;
  const properties = event.properties as Record<string, unknown> | undefined;
  if (!properties) return event;
  const nextProperties = { ...properties };
  if ("$mcp_parameters" in nextProperties) {
    nextProperties.$mcp_parameters = redactDeep(nextProperties.$mcp_parameters);
  }
  if ("$mcp_response" in nextProperties) {
    nextProperties.$mcp_response = redactDeep(nextProperties.$mcp_response);
  }
  return { ...event, properties: nextProperties };
}

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------

/**
 * Patches `server`'s request handlers to emit PostHog analytics. Must be
 * called AFTER every tool is registered — the MCP SDK lazily installs its
 * own CallToolRequestSchema handler on first registerTool(), and a handler
 * installed later would silently overwrite our patch instead of wrapping it.
 *
 * No-op when analytics is opted out (DO_NOT_TRACK=1 / ENCONVERT_MCP_ANALYTICS=off),
 * so privacy-conscious and self-hosted runs behave exactly as before this
 * instrumentation.
 */
export function instrumentServer(server: McpServer, env: Env, serverVersion: string): void {
  if (!posthog) return;

  const distinctId = distinctIdForApiKey(env.apiKey);
  const type = keyType(env.apiKey);

  // Fire eagerly, not inside identify(): started here it overlaps the MCP
  // handshake; by the time the first tool call resolves identity, the
  // whoami round trip has usually already settled.
  const projectId = resolveProjectId(env);

  instrument(server.server, posthog, {
    context: true, // captures $mcp_intent — the "why" behind each call
    enableExceptionAutocapture: true,
    identify: async () => {
      const id = await projectId;
      return { distinctId, groups: id ? { project: id } : undefined };
    },
    eventProperties: async () => ({ key_type: type, mcp_server_version: serverVersion }),
    beforeSend: (event: PostHogEvent | null | undefined) => redactToolEvent(event),
  });
}
