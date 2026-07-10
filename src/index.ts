/**
 * enconvert-mcp — entrypoint.
 *
 * Dual personality:
 *   - Launched by an MCP client (no args, stdin is a pipe): run the stdio
 *     server. This keeps every existing `npx -y @enconvert/mcp@latest`
 *     client config working unchanged.
 *   - Run by a human in a terminal: a CLI with setup / status / remove /
 *     rotate-key / run subcommands (`npx @enconvert/mcp setup`).
 */

import { Command } from "commander";
import pc from "picocolors";

import { runServer } from "./server-main.js";

const VERSION = "0.2.0";

function fatal(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[enconvert-mcp] fatal: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // MCP clients launch us with no args and a piped stdin.
  if (argv.length === 0 && !process.stdin.isTTY) {
    await runServer();
    return;
  }

  const program = new Command();
  program
    .name("enconvert-mcp")
    .description("Enconvert MCP server + zero-friction installer.\nDocs: https://enconvert.com/mcp")
    .version(VERSION);

  program
    .command("setup")
    .description("Interactive install: pick your AI tools, paste your API key, done")
    .option("-c, --clients <ids>", "comma-separated client ids (skips the picker)")
    .option("-k, --api-key <key>", "secret API key (skips the prompt)")
    .option("-y, --yes", "non-interactive: use detected clients and saved/provided key")
    .action(async (opts) => {
      const { setupCommand } = await import("./cli/commands/setup.js");
      await setupCommand(opts);
    });

  program
    .command("status")
    .description("Show where Enconvert is installed and whether the API key works")
    .action(async () => {
      const { statusCommand } = await import("./cli/commands/status.js");
      await statusCommand();
    });

  program
    .command("remove")
    .description("Uninstall the Enconvert MCP server from selected AI tools")
    .option("-c, --clients <ids>", "comma-separated client ids")
    .option("-y, --yes", "non-interactive: remove from every configured client")
    .option("--purge-key", "also delete the saved API key")
    .action(async (opts) => {
      const { removeCommand } = await import("./cli/commands/remove.js");
      await removeCommand(opts);
    });

  program
    .command("rotate-key")
    .alias("rotate_key")
    .argument("[key]", "the new secret API key (omit to be prompted with hidden input)")
    .description("Replace the stored API key - applies to all clients on next launch")
    .action(async (key?: string) => {
      const { rotateKeyCommand } = await import("./cli/commands/rotate-key.js");
      await rotateKeyCommand(key);
    });

  program
    .command("run")
    .description("Start the MCP server on stdio (what your AI tools execute)")
    .action(async () => {
      await runServer();
    });

  if (argv.length === 0) {
    // A human ran `npx @enconvert/mcp` bare in a terminal: show help.
    console.log();
    console.log(pc.bold("  Enconvert MCP"));
    console.log(pc.dim("  Web data for AI agents: render, search, extract, ingest, watch, convert."));
    console.log();
    console.log(`  Get started:  ${pc.bold("npx @enconvert/mcp setup")}`);
    console.log();
    program.outputHelp();
    return;
  }

  await program.parseAsync(process.argv);
}

main().catch(fatal);
