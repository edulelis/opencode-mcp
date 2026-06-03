# Agent Context for opencode-mcp

## Identity

You are maintaining `opencode-mcp` — an MCP **hub** server. It acts as a single entry point for ALL MCP tools, proxying to child MCP servers defined in `opencode.jsonc`.

## Architecture

```
MCP Client (Codex, Claude, etc.)
        │
        ▼
  opencode-mcp (hub)
        │
        ├── opencode serve   → agents, models (DeepSeek, Gemini, etc.)
        ├── codex            → codex, codex-reply tools
        ├── focus            → dbt_debate, dsp_*, rev_*, agt_*, focus_* tools
        └── (any MCP from opencode.jsonc's "mcp" section)
```

The hub reads the `mcp` config from `opencode.jsonc`, starts each enabled MCP server as a subprocess, discovers their tools via `tools/list`, and routes `tools/call` to the right backend.

## Key Components

### `OpencodeHub` class
- `_ensureOpencode()` — lazily starts `opencode serve` as HTTP backend
- `_startProxiedMcps()` — spawns child MCP servers from opencode.jsonc's `mcp` section
- `_waitForMcps()` — waits up to 8s for child MCPs to initialize
- `_allTools` — merges opencode tool + all proxied MCP tools
- `_toolBackend` — maps exposed tool names to `{ clientName, originalName }`

### `MCPClient` class
- Wraps a child MCP server subprocess
- Speaks JSON-RPC 2.0 over stdio
- `start()` — sends `initialize`, `notifications/initialized`, and `tools/list` to discover tools
- `callTool(name, args)` — sends `tools/call` and waits for response
- `stop()` — sends `shutdown` and kills process

## Tool Routing

The `opencode` tool is handled directly by the hub (routes to opencode serve HTTP API). All other tool names are looked up in `_toolBackend` and forwarded to the appropriate MCPClient using the child tool's original name. Colliding tool names are prefixed with the child MCP name.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.mjs` | **Single-file hub** — entire MCP server in one file |
| `tests/test.mjs` | Hermetic test suite with fake opencode and fake MCP fixtures |
| `.github/workflows/test.yml` | CI on push (Node 18/20/22) |
| `scripts/setup.sh` | One-command install from GitHub release |

## Design Rules

1. **Single MCP registration** — the user registers ONE MCP in their client
2. **Zero deps** — pure Node.js, no npm install needed
3. **Auto-discovery** — reads `mcp` from opencode.jsonc automatically
4. **Graceful degradation** — if a child MCP fails to start, log and skip
5. **All tools merged** — `tools/list` returns union of all backends
