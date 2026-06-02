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
curl -fsSL https://github.com/edulelis/opencode-mcp/releases/download/v4.1.0/opencode-mcp-v4.1.0.zip \
  -o /tmp/opencode-mcp.zip
unzip /tmp/opencode-mcp.zip -d ~/
```

Or grab just the server:

```bash
curl -fsSL https://raw.githubusercontent.com/edulelis/opencode-mcp/v4.1.0/src/index.mjs \
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
- Node.js >= 18

---

## Usage

The bridge exposes a single MCP tool called **`opencode`** with three modes:

### 1. Run an agent (with all directives)

```json
{
  "agent": "ultra",
  "prompt": "Refactor this function for readability"
}
```

Runs the agent with its full system prompt, permissions, model, and fallbacks from `opencode.jsonc`.

### 2. Direct model chat (no agent directives)

```json
{
  "model": "deepseek/deepseek-chat",
  "prompt": "Explain dependency injection"
}
```

Calls any model directly. Useful when you want a raw model response without agent wrappers.

### 3. List resources

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
| `DEBUG` | off | Set `DEBUG=1` for verbose logs |

---

## How It Works

```
MCP Client (Codex, Claude, etc.)
  ──[JSON-RPC over stdio]──> opencode-mcp (MCP server)
                                  │
                                  ├── starts `opencode serve` (headless subprocess)
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
