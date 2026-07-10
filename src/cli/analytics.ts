/**
 * PostHog instrumentation for the CLI (setup / status / remove / rotate-key).
 *
 * Separate from ../analytics.ts on purpose: the server path keeps a
 * long-lived PostHog client for the lifetime of the stdio connection, but
 * the CLI is a one-shot process that exits the instant its command
 * finishes, so it builds its own short-lived client per invocation and
 * awaits shutdown() before returning — reusing the server's singleton would
 * either leak it past process exit or force an awkward shared-lifecycle
 * dependency between two very different runtimes.
 *
 * mcp_cli_command_run shares distinctIdForApiKey(apiKey) with the server's
 * $mcp_tool_call identity (see posthog-identity.ts), so PostHog resolves
 * "ran setup" and "made tool calls" to the same Person without any extra
 * wiring.
 */

import { PostHog } from "posthog-node";

import {
  analyticsDisabled,
  distinctIdForApiKey,
  POSTHOG_HOST,
  POSTHOG_PROJECT_TOKEN,
} from "../posthog-identity.js";

export interface CaptureCliCommandOptions {
  command: string;
  apiKey?: string;
  clientsSelected?: string[];
  nonInteractive: boolean;
}

/**
 * Fire-and-forget-but-awaited CLI command event. No-op when analytics is
 * opted out or there is no API key — without a key there is no distinct_id
 * to correlate against server-side traffic, so the event would be noise.
 *
 * `onClient`, when given, runs with the SAME short-lived client before
 * shutdown() — used by rotate-key to also alias the old/new key identities
 * in one client lifecycle instead of spinning up a second one.
 */
export async function captureCliCommand(
  opts: CaptureCliCommandOptions,
  onClient?: (client: PostHog) => void | Promise<void>,
): Promise<void> {
  if (analyticsDisabled() || !opts.apiKey) return;

  const client = new PostHog(POSTHOG_PROJECT_TOKEN, { host: POSTHOG_HOST });
  try {
    client.capture({
      distinctId: distinctIdForApiKey(opts.apiKey),
      event: "mcp_cli_command_run",
      properties: {
        command: opts.command,
        ...(opts.clientsSelected ? { clients_selected: opts.clientsSelected } : {}),
        non_interactive: opts.nonInteractive,
      },
    });
    if (onClient) await onClient(client);
  } finally {
    // Required: the CLI process exits immediately after its command
    // resolves, and any events still buffered when that happens are lost.
    await client.shutdown();
  }
}
