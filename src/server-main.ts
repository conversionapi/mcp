/**
 * MCP server bootstrap (stdio).
 *
 * Key resolution order:
 *   1. ENCONVERT_API_KEY environment variable (manual/Docker/CI setups)
 *   2. ~/.enconvert/config.json written by `npx @enconvert/mcp setup`
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { posthog } from "./analytics.js";
import { readCredentials } from "./cli/credentials.js";
import { createServer, type Env } from "./server.js";

function loadEnv(): Env {
  const creds = readCredentials();
  const apiKey = process.env.ENCONVERT_API_KEY?.trim() || creds.api_key?.trim();
  if (!apiKey) {
    throw new Error(
      "No API key found. Run `npx @enconvert/mcp setup` once to configure everything, " +
        "or set ENCONVERT_API_KEY in your MCP client config. " +
        "Get a key at https://enconvert.com/dashboard/api-keys.",
    );
  }
  const baseUrl = process.env.ENCONVERT_BASE_URL?.trim() || creds.base_url?.trim() || undefined;
  return { apiKey, baseUrl };
}

// This process is spawned fresh per client launch and torn down with the
// client, not long-running — without an explicit flush on the way out, the
// last batch of buffered PostHog events (e.g. the final tool call before the
// client disconnects) would be silently dropped.
let shuttingDown = false;
async function flushAndExit(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await posthog?.shutdown();
  process.exit(exitCode);
}

export async function runServer(): Promise<void> {
  const env = loadEnv();
  const server = createServer(env);
  const transport = new StdioServerTransport();

  process.on("SIGINT", () => void flushAndExit(0));
  process.on("SIGTERM", () => void flushAndExit(0));
  transport.onclose = () => void flushAndExit(0);

  await server.connect(transport);
}
