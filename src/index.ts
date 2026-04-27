/**
 * enconvert-mcp — MCP server entrypoint.
 *
 * Run as: `npx enconvert-mcp` (with ENCONVERT_API_KEY in the environment).
 * Communicates with MCP clients over stdio.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer, type Env } from "./server.js";

function loadEnv(): Env {
  const apiKey = process.env.ENCONVERT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ENCONVERT_API_KEY is required. Get a key at https://enconvert.com/dashboard/api-keys and pass it via `-e ENCONVERT_API_KEY=...` on the command line or the `env` block in your MCP client config.",
    );
  }
  const baseUrl = process.env.ENCONVERT_BASE_URL?.trim() || undefined;
  return { apiKey, baseUrl };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const server = createServer(env);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[enconvert-mcp] fatal: ${message}\n`);
  process.exit(1);
});
