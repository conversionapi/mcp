/** `rotate-key` — swap the stored secret API key (applies to every client). */

import { password } from "@inquirer/prompts";
import ora from "ora";
import pc from "picocolors";

import { distinctIdForApiKey } from "../../posthog-identity.js";
import { captureCliCommand } from "../analytics.js";
import { credentialsPath, readCredentials, writeCredentials } from "../credentials.js";
import { validateApiKey } from "../validate.js";

export async function rotateKeyCommand(newKey?: string): Promise<void> {
  let key = newKey?.trim();
  if (!key) {
    if (!process.stdin.isTTY) {
      console.error(pc.red("No key provided. Usage: npx @enconvert/mcp rotate-key <new_api_key>"));
      process.exitCode = 1;
      return;
    }
    key = (
      await password({
        message: "Paste the NEW secret API key (input hidden):",
        mask: "*",
        validate: (v) => (v.trim().length > 0 ? true : "The key cannot be empty."),
      })
    ).trim();
  }

  const existing = readCredentials();
  const spinner = ora("Validating new key...").start();
  const verdict = await validateApiKey(key, existing.base_url);
  if (verdict.ok) {
    spinner.succeed("New key is valid.");
  } else if (verdict.reason === "network") {
    spinner.warn(verdict.message);
  } else {
    spinner.fail(verdict.message);
    console.error(pc.red("Key NOT rotated."));
    process.exitCode = 1;
    return;
  }

  const oldKey = existing.api_key;
  writeCredentials({ ...existing, api_key: key });
  console.log(`${pc.green("Rotated.")} ${pc.dim(`${credentialsPath()} updated - all clients use the new key on their next launch.`)}`);
  if (process.env.ENCONVERT_API_KEY?.trim()) {
    console.log(
      pc.yellow(
        "Note: ENCONVERT_API_KEY is set in this shell and overrides the saved key wherever that variable is present.",
      ),
    );
  }

  await captureCliCommand(
    { command: "rotate-key", apiKey: key, nonInteractive: !process.stdin.isTTY },
    async (client) => {
      if (!oldKey) return;
      try {
        // Best-effort continuity so the old and new key's server-side
        // traffic stay one Person. Note: PostHog alias merges are
        // PERMANENT — this cannot be undone if the two identities were
        // ever meant to stay separate.
        client.alias({ distinctId: distinctIdForApiKey(key), alias: distinctIdForApiKey(oldKey) });
      } catch {
        // Swallow — analytics continuity must never block key rotation.
      }
    },
  );
}
