/**
 * Central credential store: ~/.enconvert/config.json (mode 0600).
 *
 * The API key lives HERE, not in client configs — one place to rotate, no
 * secret duplicated across plaintext configs that users sync or commit.
 * The server reads it as a fallback when ENCONVERT_API_KEY is unset (the
 * environment variable always wins).
 *
 * ~/.enconvert/installations.json records where `setup` installed the
 * server so `status` and `remove` are exact.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  api_key?: string;
  base_url?: string;
}

export interface InstallRecord {
  client: string;
  /** Config file path, or "claude-cli" when installed via the claude CLI. */
  path: string;
  method: "file" | "claude-cli";
  entry: string;
  installed_at: string;
}

export function enconvertDir(): string {
  return join(homedir(), ".enconvert");
}

export function credentialsPath(): string {
  return join(enconvertDir(), "config.json");
}

function manifestPath(): string {
  return join(enconvertDir(), "installations.json");
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readCredentials(): Credentials {
  return readJson<Credentials>(credentialsPath()) ?? {};
}

export function writeCredentials(creds: Credentials): void {
  mkdirSync(enconvertDir(), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync mode only applies on creation; enforce on overwrite too.
  chmodSync(credentialsPath(), 0o600);
}

export function deleteCredentials(): boolean {
  if (!existsSync(credentialsPath())) return false;
  unlinkSync(credentialsPath());
  return true;
}

export function readManifest(): InstallRecord[] {
  return readJson<{ installs: InstallRecord[] }>(manifestPath())?.installs ?? [];
}

export function writeManifest(installs: InstallRecord[]): void {
  mkdirSync(enconvertDir(), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath(), JSON.stringify({ installs }, null, 2) + "\n");
}

export function recordInstall(record: InstallRecord): void {
  const installs = readManifest().filter((r) => r.client !== record.client);
  installs.push(record);
  writeManifest(installs);
}

export function removeInstallRecord(client: string): void {
  writeManifest(readManifest().filter((r) => r.client !== client));
}

/** The key the CLI/server would use right now, and where it came from. */
export function resolveApiKey(): { key?: string; source: "env" | "file" | "none" } {
  const envKey = process.env.ENCONVERT_API_KEY?.trim();
  if (envKey) return { key: envKey, source: "env" };
  const fileKey = readCredentials().api_key?.trim();
  if (fileKey) return { key: fileKey, source: "file" };
  return { source: "none" };
}
