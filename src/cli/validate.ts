/**
 * API key validation against the gateway.
 *
 * GET /v2/watch?limit=1 is the cheapest authenticated V2 endpoint:
 *   200 -> valid private (secret) key
 *   401 -> key not recognized
 *   403 -> a PUBLIC key (V2 and the MCP server require the secret key)
 */

export const DEFAULT_BASE_URL = "https://api.enconvert.com";

export type KeyVerdict =
  | { ok: true }
  | { ok: false; reason: "invalid" | "public-key"; message: string }
  | { ok: false; reason: "network"; message: string };

export async function validateApiKey(apiKey: string, baseUrl?: string): Promise<KeyVerdict> {
  const base = (baseUrl ?? process.env.ENCONVERT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let resp: Response;
    try {
      resp = await fetch(`${base}/v2/watch?limit=1`, {
        method: "GET",
        headers: { "X-API-Key": apiKey },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (resp.ok) return { ok: true };
    if (resp.status === 401) {
      return { ok: false, reason: "invalid", message: "The API key was not recognized. Copy the SECRET key (sk_live_...) from https://enconvert.com/dashboard/api-keys." };
    }
    if (resp.status === 403) {
      return { ok: false, reason: "public-key", message: "That looks like a PUBLIC key. The MCP server needs your SECRET API key (sk_live_...) from https://enconvert.com/dashboard/api-keys." };
    }
    return { ok: false, reason: "network", message: `Unexpected response from the API (HTTP ${resp.status}). The key was saved without validation.` };
  } catch {
    return { ok: false, reason: "network", message: "Could not reach the Enconvert API to validate the key (offline?). The key was saved without validation." };
  }
}
