/** `setup` — the interactive install wizard. */

import { checkbox, confirm, password } from "@inquirer/prompts";
import ora from "ora";
import pc from "picocolors";

import { captureCliCommand } from "../analytics.js";
import { buildRegistry, manualSnippet, type ClientDef } from "../clients.js";
import { readCredentials, recordInstall, writeCredentials } from "../credentials.js";
import { validateApiKey } from "../validate.js";

export interface SetupOptions {
  clients?: string;
  apiKey?: string;
  yes?: boolean;
}

function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 8)}...${key.slice(-4)}` : "(short key)";
}

function resolveSelection(registry: ClientDef[], csv: string): ClientDef[] {
  const wanted = csv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const known = new Map(registry.map((c) => [c.id, c]));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(
      `Unknown client(s): ${unknown.join(", ")}. Valid ids: ${registry.map((c) => c.id).join(", ")}`,
    );
  }
  return wanted.map((id) => known.get(id) as ClientDef);
}

export async function setupCommand(opts: SetupOptions): Promise<void> {
  const registry = buildRegistry();
  const detected = registry.filter((c) => c.detect());
  const interactive = process.stdin.isTTY && !opts.yes;

  console.log();
  console.log(pc.bold("  Enconvert MCP - setup"));
  console.log(pc.dim("  Configures the Enconvert MCP server for your AI tools."));
  console.log();

  // 1. Which clients?
  let selection: ClientDef[];
  if (opts.clients) {
    selection = resolveSelection(registry, opts.clients);
  } else if (!interactive) {
    selection = detected;
    if (!selection.length) {
      console.error(pc.red("No AI tools detected and none specified. Use --clients <ids>."));
      console.error(pc.dim(`Valid ids: ${registry.map((c) => c.id).join(", ")}`));
      process.exitCode = 1;
      return;
    }
  } else {
    const detectedIds = new Set(detected.map((c) => c.id));
    selection = await checkbox({
      message: "Which AI tools should get Enconvert? (space to toggle; detected tools are preselected)",
      choices: registry.map((c) => ({
        name: detectedIds.has(c.id) ? `${c.label} ${pc.green("(detected)")}` : c.label,
        value: c.id,
        checked: detectedIds.has(c.id),
      })),
    }).then((ids) => ids.map((id) => registry.find((c) => c.id === id) as ClientDef));
  }
  if (!selection.length) {
    console.log(pc.yellow("Nothing selected - nothing to do."));
    return;
  }

  // 2. The secret API key.
  let apiKey = opts.apiKey?.trim();
  const existing = readCredentials();
  if (!apiKey && existing.api_key) {
    if (
      !interactive ||
      (await confirm({
        message: `Found a saved API key (${maskKey(existing.api_key)}). Use it?`,
        default: true,
      }))
    ) {
      apiKey = existing.api_key;
    }
  }
  if (!apiKey) {
    if (!interactive) {
      console.error(pc.red("No API key available. Pass --api-key sk_live_... (or run setup interactively)."));
      process.exitCode = 1;
      return;
    }
    apiKey = (
      await password({
        message: "Paste your SECRET API key (sk_live_..., input hidden):",
        mask: "*",
        validate: (v) => (v.trim().length > 0 ? true : "The key cannot be empty."),
      })
    ).trim();
  }

  // 3. Validate against the API.
  const spinner = ora("Validating API key...").start();
  const verdict = await validateApiKey(apiKey, existing.base_url);
  if (verdict.ok) {
    spinner.succeed("API key is valid.");
  } else if (verdict.reason === "network") {
    spinner.warn(verdict.message);
  } else {
    spinner.fail(verdict.message);
    process.exitCode = 1;
    return;
  }

  // 4. Store the key centrally (never in client configs).
  writeCredentials({ ...existing, api_key: apiKey });
  console.log(pc.dim(`  Key saved to ~/.enconvert/config.json (mode 600). Rotate anytime: npx @enconvert/mcp rotate-key`));
  console.log();

  // 5. Configure each selected client.
  let failures = 0;
  for (const client of selection) {
    try {
      const outcome = client.install();
      recordInstall({
        client: client.id,
        path: outcome.location,
        method: outcome.method,
        entry: "enconvert",
        installed_at: new Date().toISOString(),
      });
      console.log(`  ${pc.green("+")} ${client.label} ${pc.dim(`- ${outcome.location}`)}`);
    } catch (e) {
      failures += 1;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ${pc.red("x")} ${client.label} ${pc.dim(`- ${msg}`)}`);
      console.log(pc.dim("    Add this entry manually:"));
      console.log(
        manualSnippet(client.id)
          .split("\n")
          .map((l) => pc.dim(`    ${l}`))
          .join("\n"),
      );
    }
  }

  console.log();
  if (failures === 0) {
    console.log(pc.green(pc.bold("  Done.")) + " Restart your AI tools to pick up the server.");
  } else {
    console.log(pc.yellow(`  Finished with ${failures} client(s) needing manual attention (see above).`));
  }
  console.log(pc.dim("  Check anytime:  npx @enconvert/mcp status"));
  console.log(pc.dim("  Uninstall:      npx @enconvert/mcp remove"));
  console.log();

  await captureCliCommand({
    command: "setup",
    apiKey,
    clientsSelected: selection.map((c) => c.id),
    nonInteractive: !interactive,
  });
}
