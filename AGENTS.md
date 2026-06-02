# Agent Context

This file is for **AI agents** (LLMs reading this repo) to understand how `opencode-mcp` works, how to maintain it, and how to use it.

## Identity

You are reading the `opencode-mcp` repository — an MCP server that lets any MCP-compatible client (Codex, Claude Desktop, etc.) call opencode agents and models.

## Core Concept

`opencode-mcp` is a **translation layer**:

```
MCP (JSON-RPC over stdio)  ←→  opencode serve HTTP API
```

It does NOT contain any AI logic itself. It delegates everything to `opencode serve`, which runs as a headless subprocess.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.mjs` | **Single-file MCP server**. Zero npm dependencies. |
| `scripts/setup.sh` | One-command installer for end users |
| `README.md` | User-facing documentation (start here) |
| `ARCHITECTURE.md` | Protocol and design details |
| `GUIDE.md` | Human-friendly walkthrough |
| `AGENTS.md` | **This file** — context for AI agents |
| `CONTRIBUTING.md` | Contribution guidelines |

## Tool: `opencode`

The bridge exposes exactly one MCP tool: **`opencode`**. It has three modes:

### Mode 1: Agent Execution

```json
{ "agent": "ultra", "prompt": "task description" }
```

Creates an opencode session with `agent` set. The opencode server applies the agent's full system prompt, permissions, model config, and fallbacks. The response is the assistant's reply.

**When to use**: The user wants code changes, architecture, review, or any task that benefits from opencode's agent directives.

### Mode 2: Direct Model Chat

```json
{ "model": "deepseek/deepseek-chat", "prompt": "question" }
```

Creates an opencode session with `model` set. Bypasses agent directives. Useful when the user explicitly asks for a specific model or wants a raw response.

**When to use**: The user asks "use DeepSeek for this" or wants to chat with a model without agent wrappers.

### Mode 3: Listing

```json
{ "list": "agents" }
{ "list": "models" }
```

Returns available agents or models from opencode.

## Architecture Notes for AI Maintainers

### Session Lifecycle

1. `ensureServer()`: Starts `opencode serve` as a subprocess. Waits for the "listening on" message.
2. `createSessionAndRun()`: POSTs to `/session`, POSTs a message, polls `GET /session/{id}/message` until stable.
3. `stopServer()`: Kills the subprocess on shutdown.

### Polling Logic

The bridge polls every 1.5s, waiting for 3 consecutive polls with the same message count. It identifies the assistant's response as the last message whose text differs from the prompt.

### Why no npm dependencies?

The bridge implements MCP JSON-RPC over stdio manually (no SDK). This keeps the install trivial — just `node` and the opencode CLI. No `npm install` needed.

### Agent Schema from opencode.jsonc

Agents are parsed from `opencode.jsonc`. The config file uses JSONC (JSON with comments). The parser strips `//` line comments (only outside strings) and `/* */` block comments.

## Testing

```bash
# Manual smoke test
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
' | node src/index.mjs

# End-to-end test with a model
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"opencode","arguments":{"agent":"quick","prompt":"say OK"}}}
' | node src/index.mjs
```

## Common Issues

- **"opencode binary not found"**: The auto-detection failed. Set `OPENCODE_BIN` explicitly.
- **"stale response"**: The polling returned old data. Check that `DELETE /session/{id}` cleanup is happening.
- **"slow first call"**: The server starts lazily on first tool call. Set `DEBUG=1` to see startup timing.

## Design Principles

1. **Zero config** — auto-detect opencode installation
2. **Zero deps** — pure Node.js, no npm packages needed
3. **Single file** — the entire server is one self-contained `.mjs` file
4. **Faithful delegation** — don't interpret or modify AI responses; pass them through
