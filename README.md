# @enconvert/mcp

Official **Model Context Protocol (MCP) server** for [Enconvert](https://enconvert.com) — lets any MCP-compatible AI agent (Claude Code, Cursor, Windsurf, Claude Desktop, Continue, etc.) convert files and URLs through a single command.

## What you get

Twenty-one tools, optimized for reliable LLM tool selection. All URL/browser work goes through the V2 tools (`perceive_url` and friends); the V1 tools cover local/remote FILE conversion.

### File conversion (3)

| Tool | What it does |
|------|-------------|
| `convert_document` | Convert DOC(X), XLS(X), PPT(X), ODT, ODS, ODP, OTS, Pages, Numbers, EPUB, HTML, MD, CSV, JSON, XML, YAML, TOML to PDF (or between each other) |
| `convert_image` | Convert between JPEG, PNG, SVG, HEIC, WebP — plus PDF → JPEG rasterization (handy for iPhone HEIC → WebP) |
| `get_job_status` | Check a single file-conversion job by its job ID |

### V2 — web data for agents (18, private API key required, plan-gated)

| Tool | What it does |
|------|-------------|
| `perceive_url` | Render a page into multiple artifacts at once (markdown, HTML, screenshots, PDF, links, images) + structured extraction, with ~1h caching |
| `get_perceive_operation` | Re-fetch a perceive result with freshly signed artifact URLs |
| `perceive_batch` | Perceive up to 1000 URLs with shared options (inline for small batches, async for large) |
| `get_perceive_batch` | Poll a perceive batch by job ID |
| `discover_urls` | Enumerate a site's URLs via sitemap/crawl/hybrid — no rendering, no render quota |
| `web_search` | Google-backed search (web, news, images, scholar, patents, maps) with optional auto-perceive of top results |
| `extract_structured` | Schema-driven data extraction (free CSS pass + LLM escalation) from up to 50 URLs or a discovered site |
| `start_ingest` | Turn a site or URL list into RAG-ready chunked JSONL (always async) |
| `list_ingest_jobs` / `get_ingest_job` / `cancel_ingest_job` | Manage ingest jobs |
| `retry_ingest_webhook` | Re-deliver a completed job's HMAC-signed completion webhook |
| `create_watcher` / `list_watchers` / `get_watcher` / `get_watcher_snapshots` / `update_watcher` / `delete_watcher` | Monitor pages for changes on an hourly-plus cadence with diff history and notifications |

Not exposed by design: the webhook signing-secret endpoints (`GET/POST /v2/ingest/webhook-secret*`) — secrets do not belong in LLM context. Fetch those from the Enconvert dashboard.

## Requirements

- **Node.js 18 or later**
- An **Enconvert API key** — get one at [enconvert.com/dashboard/api-keys](https://enconvert.com/dashboard/api-keys)

## Install — one command

```bash
npx @enconvert/mcp setup
```

That's it. The wizard:

1. **Detects your AI tools** (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Zed, Gemini CLI, Codex CLI, OpenCode) and lets you pick which get Enconvert — detected tools are preselected.
2. **Asks for your secret API key once** (hidden input) and validates it live against the API — it even tells you if you pasted a *public* key by mistake.
3. **Writes every config correctly**, including the `cmd /c npx` wrapper Windows needs. Your key is stored once in `~/.enconvert/config.json` (permissions `600`) — never copied into client configs.

```
$ npx @enconvert/mcp setup

  Enconvert MCP - setup

? Which AI tools should get Enconvert?
  [x] Claude Code (detected)    [x] Cursor (detected)
  [ ] Claude Desktop            [ ] Windsurf   ...
? Paste your SECRET API key (sk_live_..., input hidden): ********
  ✔ API key is valid.
  + Claude Code - claude CLI (user scope)
  + Cursor - ~/.cursor/mcp.json

  Done. Restart your AI tools to pick up the server.
```

Restart your AI tools afterwards, and you're running.

### Manage it just as easily

| Command | What it does |
|---|---|
| `npx @enconvert/mcp status` | Where it's installed + whether your key is valid (live check) |
| `npx @enconvert/mcp rotate-key` | Swap in a new API key — one command, applies to every client |
| `npx @enconvert/mcp remove` | Uninstall from selected tools (optionally delete the saved key) |
| `npx @enconvert/mcp setup --yes` | Non-interactive: configure all detected tools with the saved key |

Scripting? `setup --clients claude-code,cursor --api-key sk_live_... --yes` skips all prompts. `rotate-key` with no argument prompts with hidden input so the key never lands in your shell history.

### Where the key lives

`setup` stores your key **once** in `~/.enconvert/config.json` (mode `600`) instead of pasting it into every client's plaintext config. The server reads it at startup; the `ENCONVERT_API_KEY` environment variable always overrides it (for Docker, CI, or manual setups). Rotating is therefore a single-file change — every client picks it up on its next launch.

## Advanced: manual configuration

Prefer to wire it yourself? Add this to your client's MCP config (`~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, etc.):

```json
{
  "mcpServers": {
    "enconvert": {
      "command": "npx",
      "args": ["-y", "@enconvert/mcp@latest"],
      "env": {
        "ENCONVERT_API_KEY": "sk_live_your_key"
      }
    }
  }
}
```

On **native Windows**, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@enconvert/mcp@latest"]` — bare `npx` hangs. (WSL behaves like Linux.) For Claude Code:

```bash
claude mcp add enconvert -s user \
  -e ENCONVERT_API_KEY=sk_live_your_key \
  -- npx -y @enconvert/mcp@latest
```

The inline `env` block is optional if you've run `setup` (or created `~/.enconvert/config.json`) — the server falls back to the saved key automatically. Client config locations: Claude Desktop `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows); Cursor `~/.cursor/mcp.json`; Windsurf `~/.codeium/windsurf/mcp_config.json`; Gemini CLI `~/.gemini/settings.json`; Codex `~/.codex/config.toml`.

## Try it

Once installed, try any of these in a fresh prompt:

1. *"Give me https://en.wikipedia.org/wiki/Model_Context_Protocol as markdown and summarize it."* → `perceive_url`
2. *"Screenshot https://news.ycombinator.com and save the page as a PDF too."* → `perceive_url` (both artifacts in one call)
3. *"Search for the three best static site generators and read their homepages."* → `web_search` with `perceive_top`
4. *"Get every plan name and price from https://example.com/pricing."* → `extract_structured`
5. *"Convert `/Users/me/Desktop/report.docx` to PDF."* → `convert_document`
6. *"Convert `/Users/me/Desktop/iphone.heic` to webp."* → `convert_image`
7. *"Watch https://example.com/changelog and tell me when it changes."* → `create_watcher`

The agent picks the right tool automatically — descriptions are tuned so URL work lands on `perceive_url` and file work on the convert tools.

## Configuration

The API key is resolved in this order:

1. `ENCONVERT_API_KEY` environment variable (from your MCP client's `env` block) — always wins
2. `~/.enconvert/config.json`, written by `npx @enconvert/mcp setup`

| Setting | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ENCONVERT_API_KEY` (env) or `api_key` (config file) | ✅ Yes | — | Your **secret** Enconvert API key |
| `ENCONVERT_BASE_URL` (env) or `base_url` (config file) | No | `https://api.enconvert.com` | Override for staging or self-hosted Enconvert |

## How it works

The server is a thin MCP wrapper around the official [`@enconvert/node-sdk`](https://www.npmjs.com/package/@enconvert/node-sdk) — which owns all HTTP, auth, timeout (5 min), and job-polling fallback logic. Each tool handler maps MCP input to an SDK call and returns a consistent response:

- a **text summary** with the download URL(s) and metadata
- a **`structuredContent`** block with the full typed result
- a **`resource_link`** to the local file when `save_to` is provided (file tools)
- for `perceive_url`, the **markdown artifact inlined** in the response (up to ~256 KB) so agents can immediately read it without a second HTTP fetch

## Troubleshooting

**`npx` hangs on native Windows**
Use `cmd /c npx …` — the `cmd` shim handles Windows path resolution that bare `npx` does not. (`npx @enconvert/mcp setup` writes this automatically on Windows.)

**`Authentication failed: Invalid or missing API key`**
Run `npx @enconvert/mcp status` — it shows where your key comes from and validates it live. Fix with `npx @enconvert/mcp rotate-key`, or check the `ENCONVERT_API_KEY` env block if you configured manually.

**Tool call times out**
Browser renders of heavy pages (`perceive_url`, `extract_structured`) can take 15–30 s, and the SDK waits up to 5 min. If your client has a shorter timeout, raise it.

**"Relative path" error on `convert_document` / `convert_image`**
Pass an **absolute** path (e.g., `/Users/me/file.docx` or `C:\Users\me\file.docx`), or pass an `http(s)://` URL. MCP servers have no reliable working directory.

## How it depends on the Node SDK

This MCP server is a thin wrapper around [`@enconvert/node-sdk`](https://www.npmjs.com/package/@enconvert/node-sdk), which owns all HTTP, authentication, timeout, retry, and `job_id` polling-on-500 logic. New SDK releases automatically benefit the MCP server.

## License

[MIT](./LICENSE)

## Links

- **Enconvert website** — https://enconvert.com
- **Enconvert Node SDK** — https://www.npmjs.com/package/@enconvert/node-sdk
- **MCP specification** — https://modelcontextprotocol.io
- **Issues / feedback** — https://github.com/enconvert/enconvert-mcp/issues
