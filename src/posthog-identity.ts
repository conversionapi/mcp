/**
 * Shared PostHog identity primitives.
 *
 * Extracted out of analytics.ts so the server path (instrumentServer, the
 * auto-emitted $mcp_tool_call events) and the CLI path (cli/analytics.ts,
 * mcp_cli_command_run) derive distinct_id, the project token, and the
 * opt-out check from the exact same code. If these ever drifted between the
 * two call sites, the installed-vs-used correlation between
 * mcp_cli_command_run(command=setup) and $mcp_tool_call would silently
 * break — PostHog only merges them into one Person when
 * distinctIdForApiKey(apiKey) is byte-identical everywhere.
 */

import { createHash } from "node:crypto";

// --------------------------------------------------------------------------
// Token — this server runs on the *user's* machine (spawned per MCP client
// launch), not on our infrastructure, so it never sees a server-side env
// var. To make analytics actually report from the field we bake in the
// public PostHog project token as the default. This is safe: a `phc_` token
// is a write-only ingestion key — it can send events but cannot read any
// data — and the same token already ships in the Enconvert web bundle. This
// is the standard way client-side analytics (posthog-js, etc.) are
// distributed.
//
// Precedence: POSTHOG_PROJECT_API_KEY env override > baked default.
// Opt out entirely with DO_NOT_TRACK=1 (honoring the consoledonottrack.com
// convention) or ENCONVERT_MCP_ANALYTICS=off.
// --------------------------------------------------------------------------

// Public, write-only ingestion token for the Enconvert PostHog project.
export const DEFAULT_POSTHOG_PROJECT_TOKEN = "phc_BZGL6pCxCsynmq6aKB6duhrBKDHepoV4EgYGDhdQocCp";

export const POSTHOG_HOST = process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

export const POSTHOG_PROJECT_TOKEN =
  process.env.POSTHOG_PROJECT_API_KEY?.trim() || DEFAULT_POSTHOG_PROJECT_TOKEN;

/** Respect the DO_NOT_TRACK convention and an explicit product-specific switch. */
export function analyticsDisabled(): boolean {
  const doNotTrack = process.env.DO_NOT_TRACK?.trim() ?? "";
  if (/^(1|true|yes|on)$/i.test(doNotTrack)) return true;
  const optOut = process.env.ENCONVERT_MCP_ANALYTICS?.trim() ?? "";
  if (/^(0|false|no|off)$/i.test(optOut)) return true;
  return false;
}

// --------------------------------------------------------------------------
// Identity
// --------------------------------------------------------------------------

const DISTINCT_ID_HEX_CHARS = 16;

/** Stable, non-secret machine identity derived from the API key. */
export function distinctIdForApiKey(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("hex");
  return `key_${digest.slice(0, DISTINCT_ID_HEX_CHARS)}`;
}

export function keyType(apiKey: string): "private" | "public" {
  return apiKey.startsWith("pk_") ? "public" : "private";
}
