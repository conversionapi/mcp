/** `remove` — uninstall the server from selected clients. */

import { checkbox, confirm } from "@inquirer/prompts";
import pc from "picocolors";

import { captureCliCommand } from "../analytics.js";
import { buildRegistry, type ClientDef } from "../clients.js";
import { credentialsPath, deleteCredentials, removeInstallRecord, resolveApiKey } from "../credentials.js";

export interface RemoveOptions {
  clients?: string;
  yes?: boolean;
  purgeKey?: boolean;
}

export async function removeCommand(opts: RemoveOptions): Promise<void> {
  // Snapshot BEFORE any deleteCredentials/purge below — by the end of this
  // command the key we'd want to correlate against may already be gone.
  const { key: apiKeySnapshot } = resolveApiKey();
  const registry = buildRegistry();
  const installed = registry.filter((c) => c.isConfigured());
  const interactive = process.stdin.isTTY && !opts.yes;

  console.log();
  console.log(pc.bold("  Enconvert MCP - remove"));
  console.log();

  if (!installed.length && !opts.clients) {
    console.log(pc.yellow("  No Enconvert MCP installations found."));
  } else {
    let selection: ClientDef[];
    if (opts.clients) {
      const wanted = new Set(opts.clients.split(",").map((s) => s.trim().toLowerCase()));
      selection = registry.filter((c) => wanted.has(c.id));
    } else if (!interactive) {
      selection = installed;
    } else {
      const ids = await checkbox({
        message: "Remove Enconvert from which tools?",
        choices: installed.map((c) => ({ name: `${c.label} ${pc.dim(c.target())}`, value: c.id, checked: true })),
      });
      selection = installed.filter((c) => ids.includes(c.id));
    }

    for (const client of selection) {
      try {
        const removed = client.uninstall();
        removeInstallRecord(client.id);
        console.log(
          removed
            ? `  ${pc.green("-")} ${client.label} ${pc.dim("- entry removed")}`
            : `  ${pc.dim("o")} ${client.label} ${pc.dim("- nothing to remove")}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  ${pc.red("x")} ${client.label} ${pc.dim(`- ${msg}`)}`);
      }
    }
  }

  // Saved key.
  let purge = opts.purgeKey === true;
  if (!purge && interactive) {
    purge = await confirm({
      message: `Also delete the saved API key (${credentialsPath()})?`,
      default: false,
    });
  }
  if (purge) {
    console.log(
      deleteCredentials()
        ? `  ${pc.green("-")} deleted ${credentialsPath()}`
        : `  ${pc.dim("o")} no saved key to delete`,
    );
  }
  console.log();

  await captureCliCommand({
    command: "remove",
    apiKey: apiKeySnapshot,
    nonInteractive: !interactive,
  });
}
