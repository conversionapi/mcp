# @enconvert/mcp

Official **Model Context Protocol (MCP) server** for [Enconvert](https://enconvert.com) — lets any MCP-compatible AI agent (Claude Code, Cursor, Windsurf, Claude Desktop, Continue, etc.) convert files and URLs through a single command.

## What you get

Five tools, optimized for reliable LLM tool selection:

| Tool | What it does |
|------|-------------|
| `convert_url_to_pdf` | Render any live web page as a PDF |
| `convert_url_to_screenshot` | Capture a full-page PNG screenshot of any URL |
| `convert_url_to_markdown` | Extract clean GFM Markdown (with YAML frontmatter metadata) from any article — returns the text inline, ideal for summarizing, RAG, or notes |
| `convert_document` | Convert DOCX, XLSX, PPTX, ODT, Pages, Numbers, EPUB, HTML, MD, CSV, JSON, XML, YAML, TOML to PDF (or between each other) |
| `convert_image` | Convert between JPEG, PNG, SVG, HEIC, WebP (handy for iPhone HEIC → WebP) |

## Requirements

- **Node.js 18 or later**
- An **Enconvert API key** — get one at [enconvert.com/dashboard/api-keys](https://enconvert.com/dashboard/api-keys)

## Install

Pick your client below. All recipes use `npx -y @enconvert/mcp@latest` — no local install needed.

### Claude Code (macOS / Linux)

```bash
claude mcp add enconvert -s user \
  -e ENCONVERT_API_KEY=sk_live_your_key \
  -- npx -y @enconvert/mcp@latest
```

### Claude Code (native Windows)

Native Windows requires wrapping `npx` in `cmd /c` — otherwise the command hangs.

```powershell
claude mcp add enconvert -s user `
  -e ENCONVERT_API_KEY=sk_live_your_key `
  -- cmd /c npx -y @enconvert/mcp@latest
```

> **Using WSL?** Use the macOS/Linux recipe instead — no `cmd /c` needed inside WSL.

### Cursor

Edit `~/.cursor/mcp.json` (create it if missing):

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

**On native Windows** — replace the `command` and `args`:

```json
{
  "mcpServers": {
    "enconvert": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@enconvert/mcp@latest"],
      "env": {
        "ENCONVERT_API_KEY": "sk_live_your_key"
      }
    }
  }
}
```

Restart Cursor after editing.

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` — same JSON shape as Cursor. On Windows, use the `cmd /c` variant above.

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Same JSON shape as Cursor. Restart Claude Desktop after editing.

## Try it

Once installed, try any of these in a fresh prompt:

1. *"Save https://en.wikipedia.org/wiki/PDF as a PDF."*
2. *"Screenshot https://news.ycombinator.com for me."*
3. *"Give me the article at https://en.wikipedia.org/wiki/Model_Context_Protocol as markdown so we can summarize it."*
4. *"Convert `/Users/me/Desktop/report.docx` to PDF."*
5. *"Convert `/Users/me/Desktop/iphone.heic` to webp."*

The agent picks the right tool automatically — descriptions are tuned so summarize-an-article hits `convert_url_to_markdown` (cheapest on tokens) rather than `convert_url_to_pdf`.

## Configuration

All configuration is via environment variables.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ENCONVERT_API_KEY` | ✅ Yes | — | Your Enconvert API key |
| `ENCONVERT_BASE_URL` | No | `https://api.enconvert.com` | Override for staging or self-hosted Enconvert |

## How it works

The server is a thin MCP wrapper around the official [`@enconvert/node-sdk`](https://www.npmjs.com/package/@enconvert/node-sdk) — which owns all HTTP, auth, timeout (5 min), and job-polling fallback logic. Each tool handler maps MCP input to an SDK call and returns a consistent response:

- a **text summary** with the presigned download URL and metadata
- a **`structuredContent`** block with typed fields (`presignedUrl`, `objectKey`, `filename`, `fileSize`, `conversionTimeSeconds`, `savedTo?`)
- a **`resource_link`** to the local file when `save_to` is provided
- for `convert_url_to_markdown`, the **extracted Markdown inlined** in the response (up to ~256 KB) so agents can immediately read it without a second HTTP fetch

## Troubleshooting

**`npx` hangs on native Windows**
Use `cmd /c npx …` — the `cmd` shim handles Windows path resolution that bare `npx` does not.

**`Authentication failed: Invalid or missing API key`**
Double-check `ENCONVERT_API_KEY` is set in the MCP client's env block, not just your shell. MCP servers launched by Claude Code / Cursor / Windsurf only see the env vars you pass via `-e` or the config file.

**Tool call times out**
Some conversions (Playwright-rendered URL → PDF of a heavy page) can take 15–30 s, and the SDK waits up to 5 min. If your client has a shorter timeout, raise it.

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
