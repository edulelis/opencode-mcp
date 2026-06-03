# Changelog

## 5.2.0 (2026-06-03)

- **Dynamic model queries**: Short model names such as `deepseek`, `gemini`, `minimax`, `claude`, `gpt`, `flash`, and `pro` are resolved from the live `opencode models` output instead of hardcoded model IDs.
- **Dynamic modes**: `mode` is now accepted as an alias for `agent`, and agent/mode names are resolved from `opencode.jsonc` with exact or unique partial matching.
- **Portable schema**: Agent names are no longer emitted as a hardcoded JSON schema enum, so custom user modes work without code changes.
- **JSON-RPC correctness**: Tool execution errors now return MCP tool results with `isError: true`; JSON-RPC errors are reserved for protocol-level failures.
- **Safer process lifecycle**: Removed the global stale-process reaper. The bridge only stops subprocesses that it started itself.
- **Safer command execution**: Replaced shell-based `execSync` calls with argument-based `execFileSync` calls.
- **MCP proxy hardening**: Child MCP startup now sends `notifications/initialized`, cleans up failed subprocesses, rejects pending calls if a child exits, and prefixes colliding tool names.
- **Clean output by default**: Reasoning parts are no longer included in returned text unless `OPENCODE_INCLUDE_REASONING=1` is set.
- **Hermetic tests**: The test suite now uses fake opencode and fake MCP fixtures, so CI does not depend on local credentials or a real opencode install.
- **Runtime baseline**: Raised the supported runtime to Node.js 24 LTS.

## 5.1.0 (2026-06-02)

- **Timeout fixes**: Replaced hardcoded 120s/180s limits with configurable `OPENCODE_TOOL_TIMEOUT_MS` (default 10 min) and `OPENCODE_PROXY_TIMEOUT_MS` (default 5 min). Critical for DeepSeek Reasoner which needs 3–5 min for complex reviews.
- **Model placement fix**: `agent`/`model` now correctly sent to `POST /session/{id}/message` (message body) instead of `POST /session` (session creation). Chat mode now parses `"provider/model"` into `{ providerID, modelID }` format matching the Opencode API schema.
- **Error propagation**: `r()` method now surfaces actual error messages instead of hardcoded `"error"`. All error-path calls pass meaningful strings.
- **Zombie reaper**: `killStaleOpencode()` runs at startup to SIGTERM leaking `opencode serve` processes from previous bridge runs.
- **Signal handlers**: Registered `SIGTERM`, `SIGINT`, `uncaughtException` handlers for clean shutdown.
- **Server death detection**: `_pollSession` detects when the opencode server process exits and returns a clear error instead of polling silently forever.
- **Assistant error detection**: Polling loop inspects assistant message errors (provider auth errors, rate limits, etc.) and surfaces them.
- **Directory as query param**: Session `directory` now correctly sent as query parameter per the Opencode REST API.

## 4.1.0 (2026-06-02)

- Single `opencode` tool with three modes: agent, chat, list
- Auto-detect opencode binary and config
- Zero npm dependencies
- Comprehensive documentation (README, ARCHITECTURE, AGENTS, GUIDE, CONTRIBUTING)
- One-command setup script
- First public release

## 3.x (internal)

- Multiple tool approach (opencode_run, opencode_chat, opencode_agents)
- Fixed polling race conditions
- Added server lifecycle management

## 2.x (internal)

- SDK-based approach (deprecated)
- HTTP API direct calls

## 1.x (internal)

- CLI-based approach (opencode run --attach)
- Prototype phase
