# Changelog

## 5.4.13 (2026-06-08)

- **Installer state preservation**: `scripts/setup.sh` now preserves `~/.opencode-mcp/state` across updates and forced reinstalls, so durable active-job metadata is not stranded when upgrading the bridge.
- **Docs**: Clarified that the installer keeps durable job state while replacing release files.

## 5.4.12 (2026-06-08)

- **DeepSeek Reasoner progress**: Hidden `reasoning` parts now count as live session progress even when `OPENCODE_INCLUDE_REASONING` is off, avoiding false stale diagnostics while the model is still thinking after tool reads.
- **Reasoning diagnostics**: Running job status reports `phase: receiving_reasoning` plus `latest_assistant_reasoning_chars` without exposing the reasoning text by default.
- **Tests**: Added a deterministic regression where a reasoner streams hidden reasoning for multiple polls before final visible text, proving the job remains pollable and later returns the final answer.

## 5.4.11 (2026-06-07)

- **Durable active jobs**: Active opencode jobs are now persisted to disk with their session metadata and backend URL, so `opencode_job status` can recover them after the MCP bridge restarts.
- **Preserve on bridge exit**: The bridge no longer kills its `opencode serve` backend when active jobs exist. Set `OPENCODE_MCP_PRESERVE_JOBS=0` to restore cleanup-on-exit behavior.
- **Restart reattach**: `opencode serve` now starts on a known local port and is probed over HTTP, allowing the next bridge process to reattach to the same backend instead of losing in-memory job state.
- **Config**: Added `OPENCODE_MCP_STATE_DIR` for durable job state location.
- **Tests**: Added a bridge-restart regression proving a background job remains pollable and returns final output after the MCP process is killed and restarted.

## 5.4.10 (2026-06-07)

- **Codex-safe job handoff**: Lowered the default synchronous wait before returning a pollable job from 60s to 15s, so MCP clients have margin to receive the `job_id` before their own `tools/call` timeout.
- **Long-run defaults**: Disabled the hard opencode job runtime cap by default (`OPENCODE_TOOL_TIMEOUT_MS=0`) so very long agent/model jobs keep running until completion or explicit cancellation.
- **Stale jobs stay pollable**: Disabled automatic stale finalization by default (`OPENCODE_STALE_TIMEOUT_MS=0`) while keeping stale warnings and progress diagnostics. Set a positive stale timeout to restore auto-stop behavior.
- **Fallback submit resilience**: The fast `/prompt_async` request now uses the regular API timeout, while the older blocking `/message` fallback can run without a submission timeout by default.
- **Tests**: Added a long-idle job regression proving stale-warning jobs remain pollable and later deliver final output.

## 5.4.9 (2026-06-05)

- **Auto stale timeout**: Jobs with no observed session progress are now stopped and finalized as `stale_timeout` diagnostics instead of requiring a manual cancel.
- **Cached stale diagnostics**: Stale-timeout results keep the latest partial output and remain available through repeat `opencode_job status` polls for the completed-job TTL.
- **Config**: Added `OPENCODE_STALE_TIMEOUT_MS` (default `180000`); set it to `0` to disable auto stale finalization.

## 5.4.8 (2026-06-05)

- **Progress diagnostics**: Running job status now reports phase, poll count, message/assistant counts, tool-call state, finish reason, last progress age, and stale warnings.
- **Job list diagnostics**: `opencode_job list` now includes compact progress metadata for every active job.
- **Stuck-job visibility**: Completed tool-call turns that are waiting for follow-up assistant text are now shown explicitly instead of requiring log inspection.

## 5.4.7 (2026-06-05)

- **Tool-call completion guard**: Completed assistant turns that end with `finish: "tool-calls"` or contain tool-call parts are now treated as interim progress, not final output.
- **Error hardening**: Assistant errors are detected from nested and top-level message shapes, so opencode failures are surfaced instead of cached as successful text.
- **Tests**: Added a stalled tool-call regression to prevent progress text like "I'll investigate..." from being returned as a completed MCP job.

## 5.4.6 (2026-06-05)

- **Async submit endpoint**: Initial message submission now uses opencode's `/prompt_async` endpoint, falling back to `/message` only for older servers. This avoids long repo-aware prompts spending minutes inside the submit request.
- **Final-turn detection fix**: Job polling now completes only when the latest assistant message has completed final text, so completed interim tool-step messages are not mistaken for the final answer.
- **Tests**: Added a regression matching real repo-aware opencode output: a completed assistant step with `tool` parts followed by a later empty/final assistant message.

## 5.4.5 (2026-06-05)

- **Completion detection fix**: Job polling now waits for opencode's assistant completion metadata instead of treating briefly stable partial output as final.
- **Completed result cache**: Completed or timed-out tracked jobs keep their output available for repeat `opencode_job status` polls for `OPENCODE_COMPLETED_JOB_TTL_MS` (default `600000`).
- **Legacy fallback guard**: Added `OPENCODE_STABLE_COMPLETION_MS` (default `30000`) before using stable output as a completion fallback for opencode builds without completion metadata.
- **Tests**: Added a partial-then-final regression proving stable partial output remains pollable and final output can be fetched repeatedly.

## 5.4.4 (2026-06-05)

- **Long prompt submission fix**: Initial `POST /session/:id/message` submission now runs asynchronously after session creation, so slow repo-aware prompts can return a pollable job instead of failing before a job exists.
- **Message submit timeout**: Added `OPENCODE_MESSAGE_TIMEOUT_MS` (default `120000`) for initial message submission while keeping regular opencode API calls on `OPENCODE_API_TIMEOUT_MS`.

## 5.4.3 (2026-06-05)

- **Installer idempotency**: Re-running `scripts/setup.sh` with `OPENCODE_MCP_CODEX_BRIDGE_PATH` now syncs the copied bridge even when the requested version is already installed.

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
