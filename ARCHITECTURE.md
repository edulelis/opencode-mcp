# Architecture

## Overview

`opencode-bridge` is a thin MCP (Model Context Protocol) server that translates MCP tool calls into HTTP requests against `opencode serve`.

```
┌─────────────────────┐     JSON-RPC 2.0      ┌──────────────────┐
│                     │     over stdio         │                  │
│   MCP Client        │◄──────────────────────►│  opencode-bridge │
│   (Codex, Claude,   │                        │  (MCP server)    │
│    any MCP host)    │                        │                  │
│                     │                        └────────┬─────────┘
└─────────────────────┘                                 │
                                                         │ spawn + HTTP
                                                         ▼
                                                ┌──────────────────┐
                                                │  opencode serve  │
                                                │  (headless)      │
                                                │                  │
                                                │  POST /session   │
                                                │  POST /.../msg   │
                                                │  GET /.../msg    │
                                                └──────────────────┘
```

## Protocol Flow

### 1. MCP Handshake (JSON-RPC 2.0)

```
Client → Server:  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
Server → Client:  {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}

Client → Server:  {"jsonrpc":"2.0","id":2,"method":"notifications/initialized"}
Server → Client:  (no response — notification)
```

### 2. Tool Discovery

```
Client → Server:  {"jsonrpc":"2.0","id":3,"method":"tools/list"}
Server → Client:  {"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"opencode",...}]}}
```

The bridge exposes a single tool `opencode` with a flexible schema that supports agent execution, direct model chat, and listing.

### 3. Tool Execution

**Agent mode** — creates an opencode session with `agent` set:

```
Client → Server:  {"jsonrpc":"2.0","id":4,"method":"tools/call",
                    "params":{"name":"opencode","arguments":{"agent":"ultra","prompt":"hello"}}}

  Bridge → opencode serve: POST /session  {"agent":"ultra","directory":"..."}
  Bridge → opencode serve: POST /session/{id}/message  {"parts":[{"type":"text","text":"hello"}]}
  Bridge → opencode serve: GET /session/{id}/message  (poll until stable)

Server → Client:  {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"..."}]}}
```

**Chat mode** — creates an opencode session with `model` set (bypasses agent directives):

```
Same flow, but POST /session with {"model":"deepseek/deepseek-chat",...}
```

## opencode serve API

The bridge uses these endpoints from `opencode serve`:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/session` | Create a new session (supports `agent` or `model` fields) |
| `POST` | `/session/{id}/message` | Send a user message (`parts` array with `type: "text"`) |
| `GET` | `/session/{id}/message` | Poll for messages |
| `DELETE` | `/session/{id}` | Cleanup session |

Authentication: HTTP Basic Auth using `OPENCODE_SERVER_PASSWORD`.

## Response Detection Strategy

The bridge polls `GET /session/{id}/message` every 1.5s until the message count stabilizes for 3 consecutive polls. It identifies the assistant's response as the last message whose text differs from the original prompt.

## Error Handling

- **Server startup failure**: exits with clear diagnostics
- **API errors**: propagated to the MCP client as tool errors
- **Timeout**: returns whatever response was collected (180s default)

## Security

- The bridge does **not** handle or store API keys — they live in opencode's config
- Communication with `opencode serve` is localhost-only (127.0.0.1)
- `opencode serve` requires Basic Auth (password from env)
- The MCP transport is stdio — no network exposure
