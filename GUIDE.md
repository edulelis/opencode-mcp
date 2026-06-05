# Guide

A walkthrough for humans who want to understand, install, and use `opencode-mcp`.

## What This Solves

You use [opencode](https://opencode.ai) with API keys for DeepSeek, Gemini, and MiniMax. Now you also want to use those same models from:

- **Codex Desktop** (OpenAI's coding app)
- **Claude Desktop** (Anthropic's app)
- **Any MCP-compatible tool**

Without `opencode-mcp`, you'd need to configure API keys in each tool separately. With it, you configure once in opencode and the bridge shares those credentials with every MCP client.

## Step-by-Step Installation

### Prerequisites

```bash
# Install opencode (if not already installed)
curl -fsSL https://opencode.ai/install | sh

# Verify
opencode --version
```

### Install the Bridge

**Option A: One-liner (auto-downloads latest release)**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/edulelis/opencode-mcp/main/scripts/setup.sh)
```

This downloads the [latest release](https://github.com/edulelis/opencode-mcp/releases/latest)
from GitHub, extracts it to `~/.opencode-mcp`, and prints next steps. No npm, no git clone needed.

**Option B: Manual from GitHub release**

```bash
# Download the release zip
curl -fsSL https://github.com/edulelis/opencode-mcp/releases/download/v5.4.0/opencode-mcp-v5.4.0.zip \
  -o /tmp/opencode-mcp.zip
unzip /tmp/opencode-mcp.zip -d ~/
mv ~/opencode-mcp ~/.opencode-mcp
```

**Option C: Just the server file (smallest download)**

The entire MCP server is one self-contained file:

```bash
mkdir -p ~/.opencode-mcp/src
curl -fsSL https://raw.githubusercontent.com/edulelis/opencode-mcp/v5.4.0/src/index.mjs \
  -o ~/.opencode-mcp/src/index.mjs
```

**Option D: Clone the repo**

```bash
git clone https://github.com/edulelis/opencode-mcp.git ~/.opencode-mcp
```

### Register with Your MCP Client

**Codex CLI:**

```bash
codex mcp add opencode-mcp -- node /path/to/opencode-mcp/src/index.mjs
```

**Codex Desktop** also picks up MCP servers registered via `codex mcp add`.

**Claude Desktop:**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### Verify It Works

```bash
# Test the bridge directly
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"opencode","arguments":{"list":"agents"}}}
' | node src/index.mjs
```

You should see the initialize response followed by your agents list.

## Usage Examples

### From Codex Desktop

Once the MCP server is registered, Codex can call the generic `opencode` tool or the dynamic provider/family shortcut tools generated from your live `opencode models` output. You can ask:

> *"Use my review mode to review this file"*
> 
> *"Use DeepSeek and say hello"*
> 
> *"Ask Gemini to summarize this file"*
> 
> *"Call MiniMax to draft release notes"*
> 
> *"List my available opencode agents"*

The AI will automatically choose the right tool based on your request. For example, "Use DeepSeek" can route to `opencode_model_deepseek`, while "use plan mode" can route through the generic `opencode` tool with `mode: "plan"`.

### From Claude Desktop

Same principle — Claude can call `opencode` to delegate tasks to DeepSeek, Gemini, or any opencode agent.

### Direct Tool Calls

If your MCP client supports explicit tool calls, the schema is:

```json
// Run an agent/mode from your opencode config
{ "mode": "review", "prompt": "Review this API" }

// Direct model chat. Short queries are resolved from `opencode models`.
{ "model": "gemini", "prompt": "What's new in ES2025?" }

// Dynamic provider/family shortcut generated from `opencode models`.
// Tool name example: opencode_model_deepseek
{ "prompt": "Say hello" }

// List resources
{ "list": "agents" }
{ "list": "models" }
```

## Environment Configuration

The bridge auto-detects most things, but you can override:

```bash
# Custom opencode binary path
export OPENCODE_BIN=/opt/homebrew/bin/opencode

# Custom config path
export OPENCODE_CONFIG=~/.config/opencode/opencode.jsonc

# Debug mode
export DEBUG=1

# Then start
node src/index.mjs
```

## Troubleshooting

### "opencode binary not found"

The bridge searched common locations but couldn't find opencode.

```bash
# Check if opencode is installed
which opencode

# If not found, install it
curl -fsSL https://opencode.ai/install | sh

# Or set explicitly
export OPENCODE_BIN=$(which opencode)
```

### Tool call times out (180s)

The model might be slow or the server failed to start.

```bash
# Check server logs
export DEBUG=1
node src/index.mjs
```

### "API 401" error

The opencode server requires authentication. Ensure `OPENCODE_SERVER_PASSWORD` is set in your environment.

```bash
# Check if password is set
echo $OPENCODE_SERVER_PASSWORD

# If empty, generate one
export OPENCODE_SERVER_PASSWORD=$(openssl rand -hex 16)
```

### Bridge disconnects immediately

If stdin closes (e.g., when testing with `echo`), the bridge exits. Use `printf` to keep stdin open, or test with a proper MCP client.

## Updating

```bash
cd /path/to/opencode-mcp
git pull
# Restart your MCP client to pick up changes
```
