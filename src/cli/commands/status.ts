/** `status` — where the server is installed and whether the key works. */

import ora from "ora";
import pc from "picocolors";

import { captureCliCommand } from "../analytics.js";
import { buildRegistry } from "../clients.js";
import { credentialsPath, readCredentials, resolveApiKey } from "../credentials.js";
import { validateApiKey } from "../validate.js";

export async function statusCommand(): Promise<void> {
  const registry = buildRegistry();

  console.log();
  console.log(pc.bold("  Enconvert MCP - status"));
  console.log();

  // Clients.
  const labelWidth = Math.max(...registry.map((c) => c.label.length)) + 2;
  for (const client of registry) {
    const configured = client.isConfigured();
    const detected = client.detect();
    const mark = configured ? pc.green("installed") : detected ? pc.yellow("not installed") : pc.dim("not detected");
    const where = configured || detected ? pc.dim(` ${client.target()}`) : "";
    console.log(`  ${client.label.padEnd(labelWidth)} ${mark}${where}`);
  }
  console.log();

  // Key.
  const { key, source } = resolveApiKey();
  if (!key) {
    console.log(`  API key: ${pc.red("none")} - run ${pc.bold("npx @enconvert/mcp setup")}`);
    console.log();
    return;
  }
  const sourceLabel =
    source === "env"
      ? "ENCONVERT_API_KEY environment variable (overrides the saved key)"
      : credentialsPath();
  console.log(`  API key: ${pc.dim(sourceLabel)}`);

  const spinner = ora("Checking key against the API...").start();
  const verdict = await validateApiKey(key, readCredentials().base_url);
  if (verdict.ok) spinner.succeed("Key is valid.");
  else if (verdict.reason === "network") spinner.warn(verdict.message);
  else {
    spinner.fail(verdict.message);
    process.exitCode = 1;
  }
  console.log();

  await captureCliCommand({
    command: "status",
    apiKey: key,
    nonInteractive: !process.stdin.isTTY,
  });
}
