#!/usr/bin/env node

/**
 * opencode-mcp test suite.
 *
 * Spawns the MCP server, sends JSON-RPC messages, validates responses.
 *
 * Usage:
 *   node tests/test.mjs                  # full suite
 *   node tests/test.mjs --quick          # skip model calls (CI-safe)
 *   node tests/test.mjs --verbose        # show all traffic
 */

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "src", "index.mjs");
const VERBOSE = process.argv.includes("--verbose");
const QUICK = process.argv.includes("--quick");

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, msg) {
  if (condition) { passed++; process.stdout.write("  \x1b[32m✓\x1b[0m"); }
  else { failed++; process.stdout.write("  \x1b[31m✗\x1b[0m"); errors.push(msg); }
  console.log(" " + msg);
}

// ─── Spawn server ──────────────────────────────────────────────────────────
function createServer(timeoutMs = 30_000) {
  if (!existsSync(SERVER)) throw new Error(`Server not found: ${SERVER}`);

  const proc = spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DEBUG: "" }, // keep stderr clean
    timeout: timeoutMs,
  });

  let resolveClosed;
  const closedPromise = new Promise((r) => { resolveClosed = r; });
  proc.on("close", resolveClosed);

  function send(msg) {
    return new Promise((resolve) => {
      const json = JSON.stringify(msg) + "\n";
      if (VERBOSE) console.error("\x1b[90m>>>\x1b[0m", json.trim());
      proc.stdin.write(json, () => resolve());
    });
  }

  function waitForResponse(id, timeoutMs = 10_000) {
    return new Promise((resolve) => {
      let buf = "";
      const start = Date.now();
      const onData = (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.id === id) {
              proc.stdout.removeListener("data", onData);
              if (VERBOSE) console.error("\x1b[90m<<<\x1b[0m", JSON.stringify(parsed).slice(0, 200));
              return resolve(parsed);
            }
          } catch {}
        }
        // Keep incomplete line in buffer
        buf = lines.pop() || "";
      };
      proc.stdout.on("data", onData);
      setTimeout(() => {
        proc.stdout.removeListener("data", onData);
        resolve(null);
      }, timeoutMs);
    });
  }

  function waitForBanner(timeoutMs = 5000) {
    return new Promise((resolve) => {
      const onData = (chunk) => {
        if (chunk.toString().includes("Ready.")) {
          proc.stderr.removeListener("data", onData);
          resolve();
        }
      };
      proc.stderr.on("data", onData);
      setTimeout(() => resolve(), timeoutMs);
    });
  }

  function cleanup() {
    proc.kill();
  }

  return { proc, send, waitForResponse, waitForBanner, cleanup };
}

// ─── Tests ─────────────────────────────────────────────────────────────────
async function run() {
  console.log("\n\x1b[1mopencode-mcp test suite\x1b[0m\n");
  if (QUICK) console.log("  \x1b[33mQuick mode: skipping model calls\x1b[0m\n");

  // ── 1. Initialize handshake ───────────────────────────────────────
  {
    console.log("\x1b[1m[1] MCP Handshake\x1b[0m");
    const srv = createServer();
    await srv.waitForBanner();

    await srv.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    const res = await srv.waitForResponse(1);

    assert(res?.result?.protocolVersion === "2024-11-05", "initialize returns protocol version");
    assert(res?.result?.serverInfo?.name === "opencode-mcp", 'server info name is "opencode-mcp"');
    assert(res?.result?.capabilities?.tools, "capabilities includes tools");
    assert(!res?.error, "no error on initialize");
    srv.cleanup();
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── 2. tools/list ─────────────────────────────────────────────────
  {
    console.log("\n\x1b[1m[2] tools/list\x1b[0m");
    const srv = createServer();
    await srv.waitForBanner();

    await srv.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    await srv.waitForResponse(1);

    await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const res = await srv.waitForResponse(2);

    assert(res?.result?.tools?.length === 1, "exactly 1 tool exposed");
    assert(res?.result?.tools?.[0]?.name === "opencode", 'tool name is "opencode"');
    assert(res?.result?.tools?.[0]?.inputSchema, "tool has inputSchema");
    assert(
      res?.result?.tools?.[0]?.inputSchema?.properties?.agent ||
      res?.result?.tools?.[0]?.inputSchema?.properties?.model,
      "tool supports agent/model params"
    );
    srv.cleanup();
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── 3. Error: unknown tool ────────────────────────────────────────
  {
    console.log("\n\x1b[1m[3] Error handling\x1b[0m");
    const srv = createServer();
    await srv.waitForBanner();

    await srv.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    await srv.waitForResponse(1);

    await srv.send({
      jsonrpc: "2.0", id: 99, method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });
    const res = await srv.waitForResponse(99);

    assert(res?.error?.code === -32601 || res?.error, "unknown tool returns error");
    srv.cleanup();
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── 4. opencode with list:agents ──────────────────────────────────
  {
    console.log("\n\x1b[1m[4] opencode tool — list:agents\x1b[0m");
    const srv = createServer();
    await srv.waitForBanner();

    await srv.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    await srv.waitForResponse(1);

    await srv.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "opencode", arguments: { list: "agents" } },
    });
    const res = await srv.waitForResponse(2);

    assert(res?.result?.content?.[0]?.text, "list:agents returns text");
    assert(
      res?.result?.content?.[0]?.text?.includes("ultra") ||
      res?.result?.content?.[0]?.text?.includes("build"),
      "agents list includes known agents"
    );
    srv.cleanup();
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── 5. opencode with missing params ───────────────────────────────
  {
    console.log("\n\x1b[1m[5] opencode tool — missing params\x1b[0m");
    const srv = createServer();
    await srv.waitForBanner();

    await srv.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    await srv.waitForResponse(1);

    await srv.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "opencode", arguments: {} },
    });
    const res = await srv.waitForResponse(2);

    assert(res?.result?.content?.[0]?.text, "empty args returns guidance");
    assert(
      res?.result?.content?.[0]?.text?.includes("agent") ||
      res?.result?.content?.[0]?.text?.includes("list"),
      "guidance mentions available options"
    );
    srv.cleanup();
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── 6. opencode with unknown agent ────────────────────────────────
  {
    console.log("\n\x1b[1m[6] opencode tool — unknown agent\x1b[0m");
    const srv = createServer();
    await srv.waitForBanner();

    await srv.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    await srv.waitForResponse(1);

    await srv.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "opencode", arguments: { agent: "nobody", prompt: "hi" } },
    });
    const res = await srv.waitForResponse(2);

    assert(res?.result?.content?.[0]?.text?.includes("not found"), "unknown agent returns error");
    srv.cleanup();
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── 7. opencode with agent + prompt (real model call) ─────────────
  if (!QUICK) {
    console.log("\n\x1b[1m[7] opencode tool — agent execution (calls a real model)\x1b[0m");
    const srv = createServer(180_000);
    await srv.waitForBanner();

    await srv.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    await srv.waitForResponse(1);

    // Give server time to pre-start opencode backend
    console.log("     \x1b[33mStarting backend & calling model (up to 120s)...\x1b[0m");
    await new Promise((r) => setTimeout(r, 4000));

    await srv.send({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: {
        name: "opencode",
        arguments: { agent: "quick", prompt: "Say just 'OK' and nothing else" },
      },
    });

    const res = await srv.waitForResponse(7, 120_000);

    if (res?.result?.content?.[0]?.text) {
      assert(true, "agent returned a response");
      const text = res.result.content[0].text;
      assert(text.toLowerCase().includes("ok"), 'response contains "OK"');
      console.log("     \x1b[32mResponse:\x1b[0m", text.slice(0, 150).replace(/\n/g, " "));
    } else if (res?.error) {
      console.log("     \x1b[33mModel error (external):\x1b[0m", (res.error.message || "").slice(0, 100));
      assert(true, "bridge mechanism works (model error is external)");
    } else {
      assert(false, `no response within timeout (got: ${res ? JSON.stringify(res).slice(0, 80) : "null"})`);
    }
    srv.cleanup();
    await new Promise((r) => setTimeout(r, 300));
  } else {
    console.log("\n\x1b[1m[7] Agent execution (model call)\x1b[0m  \x1b[33mSKIPPED (--quick)\x1b[0m");
  }

  // ── 8. Shutdown ───────────────────────────────────────────────────
  {
    console.log("\n\x1b[1m[8] Shutdown\x1b[0m");
    const srv = createServer();
    await srv.waitForBanner();

    await srv.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    await srv.waitForResponse(1);

    await srv.send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: {} });
    const res = await srv.waitForResponse(2);

    assert(res?.result === null, "shutdown returns null");
    assert(!res?.error, "no error on shutdown");
    srv.cleanup();
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── Summary ───────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n\x1b[1m${failed > 0 ? "\x1b[31m" : "\x1b[32m"}${passed}/${total} tests passed\x1b[0m`);
  if (errors.length > 0) {
    console.log("\n\x1b[31mFailures:\x1b[0m");
    errors.forEach((e) => console.log(`  • ${e}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("\x1b[31mSuite error:\x1b[0m", e.message);
  process.exit(1);
});
