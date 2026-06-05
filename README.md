# opencode-mcp

**MCP server** that bridges any MCP-compatible client (Codex, Claude Desktop, etc.) to [opencode](https://opencode.ai) agents and models.

Use your opencode credentials (DeepSeek, Gemini, MiniMax, Anthropic) from **any** MCP host — no duplicate API keys, no reconfiguration.

---

## Install

### One-liner (auto-downloads latest release)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/edulelis/opencode-mcp/main/scripts/setup.sh)
```

This downloads the [latest release](https://github.com/edulelis/opencode-mcp/releases/latest), extracts it to `~/.opencode-mcp`, and prints registration instructions.

### Manual (just the server file)

If you only want the server file (zero dependencies, single file):

```bash
mkdir -p ~/opencode-mcp
curl -fsSL https://github.com/edulelis/opencode-mcp/releases/download/v5.4.1/opencode-mcp-v5.4.1.zip \
  -o /tmp/opencode-mcp.zip
unzip /tmp/opencode-mcp.zip -d ~/
```

Or grab just the server:

```bash
curl -fsSL https://raw.githubusercontent.com/edulelis/opencode-mcp/v5.4.1/src/index.mjs \
  -o ~/opencode-mcp/index.mjs
```

### Register with your client

```bash
# Codex
codex mcp add opencode-mcp -- node ~/.opencode-mcp/src/index.mjs

# Claude Desktop — add to claude_desktop_config.json:
# { "mcpServers": { "opencode-mcp": {
#     "command": "node",
#     "args": ["~/.opencode-mcp/src/index.mjs"]
# } } }
```

### Requirements

- [opencode CLI](https://opencode.ai) installed (`curl -fsSL https://opencode.ai/install | sh`)
- Node.js >= 24 LTS

---

## Usage

The bridge exposes a primary MCP tool called **`opencode`** plus dynamic model shortcut tools.

### From Codex in natural language

After registering the MCP server in Codex, you can ask for opencode models directly:

> "Use DeepSeek and say hello"
>
> "Ask Gemini to summarize this file"
>
> "Call MiniMax to draft release notes"
>
> "Use plan mode to sketch the implementation"

Codex sees the live MCP tool list and can route those requests to dynamic tools such as `opencode_model_deepseek`, `opencode_model_gemini`, or `opencode_model_minimax`. Provider shortcuts use **no project context by default**; ask for a repository review or set `context: "cwd"` only when the model should see the current working directory.

### 1. Run an agent (with all directives)

```json
{
  "agent": "your-agent",
  "prompt": "Refactor this function for readability"
}
```

Runs the agent with its full system prompt, permissions, model, and fallbacks from `opencode.jsonc`. Agent names are discovered from your config at startup, so custom modes work without code changes.

You can also use `mode` as an alias for `agent`, and unique partial names are accepted:

```json
{
  "mode": "plan",
  "prompt": "Sketch the implementation steps"
}
```

### 2. Direct model chat (no agent directives)

```json
{
  "model": "deepseek",
  "prompt": "Explain dependency injection"
}
```

Calls any model directly. Full model IDs still work, but short queries are resolved from `opencode models`, not hardcoded in this bridge.

Examples:

```json
{ "model": "deepseek", "prompt": "Say hello" }
{ "model": "gemini", "prompt": "Summarize this" }
{ "model": "minimax", "prompt": "Draft release notes" }
{ "model": "claude", "prompt": "Review this API" }
{ "model": "flash", "prompt": "Quick answer" }
```

### 3. Dynamic provider/family shortcuts

On `tools/list`, the bridge reads `opencode models` and automatically exposes provider/family tools:

```text
opencode_model_deepseek
opencode_model_google
opencode_model_gemini
opencode_model_minimax
opencode_model_anthropic
opencode_model_claude
opencode_model_openai
opencode_model_gpt
```

The exact tools depend on your opencode model list. These shortcuts default to **no project context**, which makes requests like "call DeepSeek and say hello" easier for MCP clients to route without leaking the current repo context.

```json
{
  "prompt": "Say hello"
}
```

You can still choose a specific model/query inside the provider:

```json
{
  "model": "reasoner",
  "prompt": "Think through this"
}
```

Set `context` to `cwd` only when you want the provider shortcut to see the current working directory:

```json
{
  "context": "cwd",
  "prompt": "Review this repository"
}
```

### 4. Long-running jobs

Slow models can exceed an MCP client's own `tools/call` timeout. The bridge avoids this by returning a pollable job before the client timeout is reached:

```text
Opencode job is still running.
job_id: s1
status: running
```

Poll it with `opencode_job`:

```json
{
  "action": "status",
  "job_id": "s1",
  "wait_ms": 30000
}
```

You can also start a call in the background immediately:

```json
{
  "background": true,
  "prompt": "Run a deep review"
}
```

Use `{"action":"list"}` to list running jobs and `{"action":"cancel","job_id":"s1"}` to cancel one.

### 5. List resources

```json
{ "list": "agents" }
{ "list": "models" }
```

---

## Clients

### Codex (OpenAI)

```bash
codex mcp add opencode-mcp -- node /path/to/opencode-mcp/src/index.mjs
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "opencode-mcp": {
      "command": "node",
      "args": ["/path/to/opencode-mcp/src/index.mjs"]
    }
  }
}
```

### Any MCP host

The bridge speaks standard MCP over stdio. Works with any client that supports the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_BIN` | auto-detect | Path to opencode binary |
| `OPENCODE_CONFIG` | auto-detect | Path to opencode.jsonc |
| `OPENCODE_SERVER_PASSWORD` | from env | Password for opencode serve |
| `OPENCODE_MCP_SKIP` | none | Comma-separated MCP names to skip from `opencode.jsonc` |
| `OPENCODE_TOOL_TIMEOUT_MS` | `600000` | Max wait for opencode agent/model calls |
| `OPENCODE_MCP_RETURN_TIMEOUT_MS` | `60000` | Max synchronous wait before returning a pollable `opencode_job` |
| `OPENCODE_API_TIMEOUT_MS` | `10000` | Max wait for one opencode HTTP API request |
| `OPENCODE_PROXY_TIMEOUT_MS` | `300000` | Max wait for proxied child MCP tools |
| `OPENCODE_MODEL_CACHE_MS` | `60000` | Cache duration for `opencode models` discovery |
| `OPENCODE_POLL_INTERVAL_MS` | `2000` | Poll interval for opencode sessions |
| `OPENCODE_INCLUDE_REASONING` | off | Set `1` to include reasoning parts in returned text |
| `OPENCODE_ALIAS_TOOLS` | `providers` | `providers` generates provider/family shortcuts, `models` generates one per model, `off` disables shortcuts |
| `DEBUG` | off | Set `DEBUG=1` for verbose logs |

---

## How It Works

```
MCP Client (Codex, Claude, etc.)
  ──[JSON-RPC over stdio]──> opencode-mcp (MCP server)
                                  │
                                  ├── starts `opencode serve` lazily when a model/agent is called
                                  ├── creates session with agent/model
                                  ├── sends prompt via HTTP API
                                  ├── polls for response
                                  └── returns result
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full protocol detail.

---

## Why?

If you use **opencode** with multiple AI providers (DeepSeek, Gemini, MiniMax, Anthropic), you already have API keys configured in `opencode.jsonc`. Instead of copying those keys to every MCP client, this bridge lets them all share opencode's credentials and agents.

---

## Project Structure

```
opencode-mcp/
├── src/index.mjs         MCP server (single file, zero deps)
├── scripts/setup.sh      One-command installer
├── ARCHITECTURE.md       Protocol & design docs
├── AGENTS.md             Context for AI agents (read this first)
├── GUIDE.md              Human-friendly walkthrough
├── CONTRIBUTING.md       How to contribute
└── CHANGELOG.md          Release history
```

---

## License

MIT © Eduardo Lelis
