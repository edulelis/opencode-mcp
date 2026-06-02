# Contributing

## Development

```bash
git clone https://github.com/edulelis/opencode-mcp.git
cd opencode-mcp

# Test directly
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node src/index.mjs
```

## Structure

- `src/index.mjs` — single-file MCP server, zero dependencies
- `scripts/setup.sh` — one-command install
- `docs/` — markdown documentation

## Guidelines

1. **Zero dependencies** — keep `src/index.mjs` pure Node.js
2. **Self-contained** — the MCP server is one file for easy distribution
3. **Debug logging** — use `if (IS_DEBUG) console.error(...)` pattern
4. **Compatibility** — support Node.js >= 18
5. **Error messages** — be descriptive; the bridge runs headless, errors must be clear

## Testing

```bash
# Manual init & tools/list
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
' | node src/index.mjs

# Manual tool call (requires opencode + credentials)
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"opencode","arguments":{"agent":"quick","prompt":"say OK"}}}
' | node src/index.mjs
```

## Pull Requests

- Explain what the change does and why
- Keep the single-file architecture if possible
- Update docs (README, ARCHITECTURE, AGENTS, GUIDE) if behavior changes
- Add a CHANGELOG entry
