# Architecture

## Overview

`opencode-mcp` is an MCP **hub** — a single entry point that delegates to multiple backends.

```
┌──────────────────────┐     JSON-RPC 2.0      ┌───────────────────────────┐
│                      │     over stdio         │                           │
│   MCP Client         │◄──────────────────────►│     opencode-mcp (hub)    │
│   (Codex, Claude,    │                        │                           │
│    any MCP host)     │                        │  Tool routing:            │
│                      │                        │  ┌─────────────────────┐  │
└──────────────────────┘                        │  │ opencode (direct)   │  │
                                                │  ├─────────────────────┤  │
                                                │  │ opencode_model_*    │  │
                                                │  ├─────────────────────┤  │
                                                │  │ codex → MCPClient   │  │
                                                │  ├─────────────────────┤  │
                                                │  │ focus → MCPClient   │  │
                                                │  └─────────────────────┘  │
                                                └───────────┬───────────────┘
                                                            │
                                        spawn + HTTP/stdio   │
                                                            │
                    ┌───────────────────────┬────────────────┴───────────────┐
                    │                       │                                │
                    ▼                       ▼                                ▼
          ┌──────────────────┐   ┌──────────────────┐        ┌──────────────────┐
          │  opencode serve  │   │  codex mcp-server │        │  focus start     │
          │  (HTTP)          │   │  (stdio MCP)      │        │  (stdio MCP)     │
          └──────────────────┘   └──────────────────┘        └──────────────────┘
```

## MCP Proxy Protocol

Each child MCP server runs as a subprocess communicating via JSON-RPC 2.0 over stdio.

### Initialization Flow

```
Hub → Child:  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
Child → Hub:  {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}

Hub → Child:  {"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
Hub → Child:  {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
Child → Hub:  {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}

Hub stores tools in _toolBackend[exposedName] = { clientName, originalName }.
If two child MCPs expose the same tool name, the later one is prefixed with the child MCP name.
```

### Tool Execution Flow

```
Client → Hub:  {"method":"tools/call","params":{"name":"dbt_debate",...}}
Hub → Child:   {"jsonrpc":"2.0","id":3,"method":"tools/call",
                 "params":{"name":"<original child tool name>","arguments":{...}}}
Child → Hub:   {"jsonrpc":"2.0","id":3,"result":{"content":[...]}}
Hub → Client:  {"result":{"content":[...]}}
```

## Backend Details

### opencode serve (direct HTTP)
- Started lazily on a bridge-selected local port and probed over HTTP
- Backend URL/PID and active opencode job metadata are persisted under `OPENCODE_MCP_STATE_DIR`
- When active jobs exist, bridge shutdown preserves the opencode server so a restarted bridge can reattach and poll them
- Communicates via HTTP with Basic Auth
- Used by the `opencode` tool for agents and model calls
- Dynamic shortcut tools are generated from `opencode models` as `opencode_model_<provider-or-family>` by default.
- Shortcut tools default to an empty temporary working directory (`context: "none"`) so provider-only requests do not inherit the current repository context.

### Codex MCP Server
- Command: `codex mcp-server`
- Provides `codex` and `codex-reply` tools

### FocusMCP
- Command: `focus start`
- Provides 37 tools for debate, review, dispatch, agent management, bricks, catalog

## Configuration

The hub reads the `mcp` section from `opencode.jsonc`:

```json
{
  "mcp": {
    "codex": { "type": "local", "command": ["codex", "mcp-server"], "enabled": true },
    "focus": { "type": "local", "command": ["focus", "start"], "enabled": true }
  }
}
```

To skip specific MCPs: `export OPENCODE_MCP_SKIP=codex,focus`

To control dynamic model tools:

```bash
export OPENCODE_ALIAS_TOOLS=providers  # default: provider/family tools
export OPENCODE_ALIAS_TOOLS=models     # one tool per full model ID
export OPENCODE_ALIAS_TOOLS=off        # disable model shortcut tools
```
