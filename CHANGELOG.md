# Changelog

## 5.4.2 (2026-06-05)

- **Install/update script**: `scripts/setup.sh` now handles first install, update, no-op when already current, and forced reinstall through the same path.
- **Safer updates**: Existing installs are replaced cleanly after a timestamped backup, avoiding stale files from older releases.
- **Local compatibility**: Node.js < 24 is now a warning during install/update instead of blocking downloads, while still warning that Node.js >= 24 is required to run the MCP server.
- **Copied bridge sync**: Added `OPENCODE_MCP_CODEX_BRIDGE_PATH` for setups that need to sync a copied bridge file after install/update.

## 5.4.1 (2026-06-05)

- **Release metadata fix**: Corrected the MCP server `serverInfo.version` and startup banner to match the package/release version.
- **Tests**: Added a guard that fails when the package version and runtime `VERSION` constant drift.

## 5.4.0 (2026-06-05)

- **Async opencode jobs**: Long-running agent/model calls now return a pollable `job_id` before MCP clients can hit their own `tools/call` timeout. Use `opencode_job` to poll, list, or cancel jobs.
- **Background mode**: `opencode` and dynamic `opencode_model_*` tools now accept `background: true` and `wait_ms` for explicit lifecycle control.
- **HTTP API timeout**: Added `OPENCODE_API_TIMEOUT_MS` so one stalled opencode HTTP request cannot hang the bridge indefinitely.
- **Tests**: Added a fake slow-model regression test proving slow calls return a job and can later be polled to completion.

## 5.3.0 (2026-06-03)

- **Dynamic provider/family tools**: `tools/list` now generates `opencode_model_<provider-or-family>` shortcuts from the live `opencode models` output, so MCP clients can discover DeepSeek, Gemini, Claude, MiniMax, OpenAI/GPT, and future providers without hardcoded tool names.
- **No-context shortcuts**: Dynamic model shortcut tools default to `context: "none"` using an empty temporary directory, while the generic `opencode` tool keeps `cwd` as its default.
- **Alias modes**: Added `OPENCODE_ALIAS_TOOLS=providers|models|off` to choose one tool per provider, one tool per full model, or disable shortcuts.
- **Tests**: Added coverage for dynamic provider discovery, per-model aliases, alias disabling, provider-local model selection, and no-context defaults.

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
