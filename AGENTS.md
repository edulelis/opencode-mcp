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
        ├── opencode serve   → agents, models, dynamic provider/family shortcuts
        ├── codex            → codex, codex-reply tools
        ├── focus            → dbt_debate, dsp_*, rev_*, agt_*, focus_* tools
        └── (any MCP from opencode.jsonc's "mcp" section)
```

The hub reads the `mcp` config from `opencode.jsonc`, starts each enabled MCP server as a subprocess, discovers their tools via `tools/list`, and routes `tools/call` to the right backend.

## Key Components

### `OpencodeHub` class
- `_ensureOpencode()` — lazily starts or reattaches to `opencode serve` as HTTP backend
- `_loadState()` / `_saveState()` — persist active job metadata, completed results, and backend URL/PID
- `_startProxiedMcps()` — spawns child MCP servers from opencode.jsonc's `mcp` section
- `_waitForMcps()` — waits up to 8s for child MCPs to initialize
- `_refreshModelAliasTools()` — reads `opencode models` and creates dynamic `opencode_model_<provider-or-family>` tools
- `_createOpencodeJob()` / `_jobToolCall()` — create, persist, poll, list, and cancel long-running opencode sessions
- `_allTools` — merges opencode tool + dynamic model tools + all proxied MCP tools
- `_toolBackend` — maps exposed tool names to `{ clientName, originalName }`

### `MCPClient` class
- Wraps a child MCP server subprocess
- Speaks JSON-RPC 2.0 over stdio
- `start()` — sends `initialize`, `notifications/initialized`, and `tools/list` to discover tools
- `callTool(name, args)` — sends `tools/call` and waits for response
- `stop()` — sends `shutdown` and kills process

## Tool Routing

The `opencode` tool is handled directly by the hub (routes to opencode serve HTTP API). Long-running calls return a pollable `job_id` before MCP clients hit their own call timeout, and active jobs are persisted so they can survive bridge restarts while the machine and opencode backend stay alive. Dynamic model shortcut tools such as `opencode_model_deepseek` and `opencode_model_claude` are generated from `opencode models` and default to no project context. All other tool names are looked up in `_toolBackend` and forwarded to the appropriate MCPClient using the child tool's original name. Colliding tool names are prefixed with the child MCP name.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.mjs` | **Single-file hub** — entire MCP server in one file |
| `tests/test.mjs` | Hermetic test suite with fake opencode and fake MCP fixtures |
| `.github/workflows/test.yml` | CI on push (Node 24 LTS) |
| `scripts/setup.sh` | One-command install from GitHub release |

## Design Rules

1. **Single MCP registration** — the user registers ONE MCP in their client
2. **Zero deps** — pure Node.js, no npm install needed
3. **Auto-discovery** — reads `mcp` from opencode.jsonc automatically
4. **Graceful degradation** — if a child MCP fails to start, log and skip
5. **All tools merged** — `tools/list` returns union of all backends
6. **Natural model routing** — clients such as Codex should be able to route prompts like "use DeepSeek" or "ask Gemini" from the dynamic `opencode_model_*` tools without hardcoded provider names
7. **Durable long jobs** — active opencode jobs should not be killed by MCP call timeout or bridge restart; explicit `opencode_job cancel` remains the cleanup path
