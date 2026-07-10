/**
 * Client registry: every AI tool `setup` can configure, with detection,
 * platform-aware config paths, and format adapters (JSON variants + TOML).
 *
 * Config writes are read-modify-write: unrelated keys are preserved, and a
 * one-time `<file>.enconvert-backup` copy is made before the first edit.
 * A config that exists but cannot be parsed (e.g. JSONC with comments) is
 * never touched — install() throws and the wizard prints a manual snippet.
 *
 * No secrets are written into any client config: the server reads the API
 * key from ~/.enconvert/config.json (or the ENCONVERT_API_KEY env var).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const SERVER_NAME = "enconvert";
const PACKAGE_SPEC = "@enconvert/mcp@latest";

export interface InstallOutcome {
  /** Where the entry was written ("claude CLI (user scope)" for the CLI path). */
  location: string;
  method: "file" | "claude-cli";
}

export interface ClientDef {
  id: string;
  label: string;
  detect(): boolean;
  /** Human-readable target shown in prompts and status. */
  target(): string;
  isConfigured(): boolean;
  install(): InstallOutcome;
  /** Returns true when an entry was found and removed. */
  uninstall(): boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** npx invocation for this platform (Windows needs the cmd shim). */
export function commandShape(): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", PACKAGE_SPEC] }
    : { command: "npx", args: ["-y", PACKAGE_SPEC] };
}

function appDataDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

function backupOnce(path: string): void {
  const backup = `${path}.enconvert-backup`;
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
}

function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      `could not parse ${path} (comments or trailing commas?). Not touching it.`,
    );
  }
}

function writeConfigFile(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  backupOnce(path);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

function sectionOf(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = config[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  config[key] = fresh;
  return fresh;
}

/** Factory for JSON-config clients; only the entry shape and paths differ. */
function jsonClient(opts: {
  id: string;
  label: string;
  configPath: () => string;
  detectPath: () => string;
  /** Top-level key holding the server map (mcpServers / servers / ...). */
  sectionKey: string;
  entry: () => Record<string, unknown>;
}): ClientDef {
  return {
    id: opts.id,
    label: opts.label,
    detect: () => existsSync(opts.detectPath()),
    target: () => opts.configPath(),
    isConfigured: () => {
      try {
        const section = readConfigFile(opts.configPath())[opts.sectionKey];
        return !!section && typeof section === "object" && SERVER_NAME in (section as object);
      } catch {
        return false;
      }
    },
    install: () => {
      const path = opts.configPath();
      const config = readConfigFile(path);
      sectionOf(config, opts.sectionKey)[SERVER_NAME] = opts.entry();
      writeConfigFile(path, config);
      return { location: path, method: "file" };
    },
    uninstall: () => {
      const path = opts.configPath();
      if (!existsSync(path)) return false;
      const config = readConfigFile(path);
      const section = config[opts.sectionKey];
      if (!section || typeof section !== "object" || !(SERVER_NAME in (section as object))) {
        return false;
      }
      delete (section as Record<string, unknown>)[SERVER_NAME];
      writeConfigFile(path, config);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Claude Code — prefer the official CLI (handles ~/.claude.json safely).
// ---------------------------------------------------------------------------

function claudeCliAvailable(): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

function claudeCodeClient(): ClientDef {
  const configPath = () => join(homedir(), ".claude.json");
  return {
    id: "claude-code",
    label: "Claude Code",
    detect: () => existsSync(configPath()) || existsSync(join(homedir(), ".claude")) || claudeCliAvailable(),
    target: () => (claudeCliAvailable() ? "claude CLI (user scope)" : configPath()),
    isConfigured: () => {
      try {
        const servers = readConfigFile(configPath()).mcpServers;
        return !!servers && typeof servers === "object" && SERVER_NAME in (servers as object);
      } catch {
        return false;
      }
    },
    install: () => {
      const { command, args } = commandShape();
      if (claudeCliAvailable()) {
        const spec = JSON.stringify({ type: "stdio", command, args });
        const result = spawnSync("claude", ["mcp", "add-json", SERVER_NAME, spec, "-s", "user"], {
          stdio: "ignore",
        });
        if (result.status === 0) return { location: "claude CLI (user scope)", method: "claude-cli" };
        // Fall through to direct file edit if the CLI refused.
      }
      const path = configPath();
      const config = readConfigFile(path);
      sectionOf(config, "mcpServers")[SERVER_NAME] = { type: "stdio", command, args };
      writeConfigFile(path, config);
      return { location: path, method: "file" };
    },
    uninstall: () => {
      if (claudeCliAvailable()) {
        const result = spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"], {
          stdio: "ignore",
        });
        if (result.status === 0) return true;
      }
      const path = configPath();
      if (!existsSync(path)) return false;
      const config = readConfigFile(path);
      const servers = config.mcpServers;
      if (!servers || typeof servers !== "object" || !(SERVER_NAME in (servers as object))) {
        return false;
      }
      delete (servers as Record<string, unknown>)[SERVER_NAME];
      writeConfigFile(path, config);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Codex — TOML config.
// ---------------------------------------------------------------------------

function codexClient(): ClientDef {
  const configPath = () => join(homedir(), ".codex", "config.toml");
  const read = (): Record<string, unknown> => {
    const path = configPath();
    if (!existsSync(path)) return {};
    try {
      return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`could not parse ${path}. Not touching it.`);
    }
  };
  return {
    id: "codex",
    label: "Codex CLI",
    detect: () => existsSync(join(homedir(), ".codex")),
    target: () => configPath(),
    isConfigured: () => {
      try {
        const servers = read().mcp_servers;
        return !!servers && typeof servers === "object" && SERVER_NAME in (servers as object);
      } catch {
        return false;
      }
    },
    install: () => {
      const path = configPath();
      const config = read();
      const { command, args } = commandShape();
      sectionOf(config, "mcp_servers")[SERVER_NAME] = { command, args };
      mkdirSync(dirname(path), { recursive: true });
      backupOnce(path);
      writeFileSync(path, stringifyToml(config) + "\n");
      return { location: path, method: "file" };
    },
    uninstall: () => {
      const path = configPath();
      if (!existsSync(path)) return false;
      const config = read();
      const servers = config.mcp_servers;
      if (!servers || typeof servers !== "object" || !(SERVER_NAME in (servers as object))) {
        return false;
      }
      delete (servers as Record<string, unknown>)[SERVER_NAME];
      backupOnce(path);
      writeFileSync(path, stringifyToml(config) + "\n");
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function buildRegistry(): ClientDef[] {
  const std = commandShape();

  return [
    claudeCodeClient(),
    jsonClient({
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: () => join(appDataDir(), "Claude", "claude_desktop_config.json"),
      detectPath: () => join(appDataDir(), "Claude"),
      sectionKey: "mcpServers",
      entry: () => ({ command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "cursor",
      label: "Cursor",
      configPath: () => join(homedir(), ".cursor", "mcp.json"),
      detectPath: () => join(homedir(), ".cursor"),
      sectionKey: "mcpServers",
      entry: () => ({ command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "windsurf",
      label: "Windsurf",
      configPath: () => join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
      detectPath: () => join(homedir(), ".codeium", "windsurf"),
      sectionKey: "mcpServers",
      entry: () => ({ command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "vscode",
      label: "VS Code (Copilot)",
      configPath: () => join(appDataDir(), "Code", "User", "mcp.json"),
      detectPath: () => join(appDataDir(), "Code"),
      sectionKey: "servers",
      entry: () => ({ type: "stdio", command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "zed",
      label: "Zed",
      configPath: () =>
        process.platform === "win32"
          ? join(appDataDir(), "Zed", "settings.json")
          : join(homedir(), ".config", "zed", "settings.json"),
      detectPath: () =>
        process.platform === "win32"
          ? join(appDataDir(), "Zed")
          : join(homedir(), ".config", "zed"),
      sectionKey: "context_servers",
      entry: () => ({ source: "custom", command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "gemini-cli",
      label: "Gemini CLI",
      configPath: () => join(homedir(), ".gemini", "settings.json"),
      detectPath: () => join(homedir(), ".gemini"),
      sectionKey: "mcpServers",
      entry: () => ({ command: std.command, args: std.args }),
    }),
    codexClient(),
    jsonClient({
      id: "opencode",
      label: "OpenCode",
      configPath: () => join(homedir(), ".config", "opencode", "opencode.json"),
      detectPath: () => join(homedir(), ".config", "opencode"),
      sectionKey: "mcp",
      entry: () => ({ type: "local", command: [std.command, ...std.args], enabled: true }),
    }),
  ];
}

/** Manual config snippet printed when a config cannot be edited safely. */
export function manualSnippet(clientId: string): string {
  const { command, args } = commandShape();
  if (clientId === "codex") {
    return `[mcp_servers.${SERVER_NAME}]\ncommand = "${command}"\nargs = [${args.map((a) => `"${a}"`).join(", ")}]`;
  }
  if (clientId === "opencode") {
    return JSON.stringify({ mcp: { [SERVER_NAME]: { type: "local", command: [command, ...args], enabled: true } } }, null, 2);
  }
  if (clientId === "vscode") {
    return JSON.stringify({ servers: { [SERVER_NAME]: { type: "stdio", command, args } } }, null, 2);
  }
  if (clientId === "zed") {
    return JSON.stringify({ context_servers: { [SERVER_NAME]: { source: "custom", command, args } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args } } }, null, 2);
}
