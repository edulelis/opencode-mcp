#!/usr/bin/env node

/**
 * opencode-mcp test suite.
 *
 * The default suite is hermetic: it uses a temporary opencode config,
 * a fake opencode binary, and fake child MCP servers. No real credentials
 * or local opencode installation are required.
 *
 * Usage:
 *   node tests/test.mjs
 *   node tests/test.mjs --verbose
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "src", "index.mjs");
const VERBOSE = process.argv.includes("--verbose");

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS ${msg}`);
  } else {
    failed++;
    errors.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

function fixture({ opencode = true, mcps = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opencode-mcp-test-"));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const configPath = join(root, "opencode.jsonc");
  const opencodePath = join(binDir, "opencode");
  const mcpPath = join(binDir, "fake-mcp");

  writeFileSync(configPath, JSON.stringify({
    agent: {
      scout: { description: "Fast scout mode", model: "deepseek/deepseek-chat" },
      builder: { description: "Build mode", model: "minimax/MiniMax-M3" },
    },
    mcp: mcps ? {
      alpha: { type: "local", command: [mcpPath], env: { FAKE_MCP_NAME: "alpha" } },
      beta: { type: "local", command: [mcpPath], env: { FAKE_MCP_NAME: "beta" } },
    } : {},
  }, null, 2));

  writeFileSync(join(root, ".keep"), "");
  awaitableMkdir(home);
  awaitableMkdir(binDir);

  if (opencode) {
    writeFileSync(opencodePath, `#!/usr/bin/env node
const http = require("node:http");

const models = [
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "google/gemini-2.5-flash",
  "minimax/MiniMax-M3",
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-5.4-mini"
];

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

if (process.argv[2] === "models") {
  console.log(models.join("\\n"));
  process.exit(0);
}

if (process.argv[2] !== "serve") {
  console.error("unknown fake opencode command");
  process.exit(1);
}

let nextSession = 1;
const sessions = new Map();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (req.method === "POST" && url.pathname === "/session") {
    const id = "s" + nextSession++;
    sessions.set(id, { response: "", directory: url.searchParams.get("directory") || "", readyAt: 0, createdAt: Date.now() });
    return send(res, 200, { id });
  }

  const match = url.pathname.match(/^\\/session\\/([^/]+)(?:\\/(message|prompt_async))?$/);
  if (!match) return send(res, 404, { error: "not found" });
  const sid = match[1];
  const session = sessions.get(sid);
  if (!session) return send(res, 404, { error: "missing session" });

  if (req.method === "POST" && (url.pathname.endsWith("/message") || url.pathname.endsWith("/prompt_async"))) {
    const body = await readBody(req);
    const prompt = body.parts?.[0]?.text || "";
    if (body.agent) {
      session.response = "agent=" + body.agent + " dir=" + session.directory + " OK";
    } else if (body.model) {
      session.response = "model=" + body.model.providerID + "/" + body.model.modelID + " dir=" + session.directory + " OK";
    } else {
      session.response = "chat dir=" + session.directory + " OK";
    }
    session.prompt = prompt;
    const submitDelay = prompt.includes("slow-submit") ? 180 : 0;
    session.readyAt = prompt.includes("slow-response") || submitDelay ? Date.now() + 180 : Date.now();
    if (prompt.includes("partial-then-final")) {
      session.response = "PARTIAL: still investigating";
      session.finalResponse = "FINAL: model=deepseek/deepseek-chat complete";
      session.readyAt = Date.now();
      session.finalAt = Date.now() + 280;
    }
    if (prompt.includes("tool-step-final")) {
      session.response = "Let me inspect the requested files.";
      session.finalResponse = "FINAL_TOOL_STEP: scenario runner is pnpm run test:scenario";
      session.readyAt = Date.now();
      session.finalAt = Date.now() + 280;
      session.toolStepFinal = true;
    }
    if (submitDelay && url.pathname.endsWith("/message")) {
      setTimeout(() => send(res, 200, { id: "m1" }), submitDelay);
      return;
    }
    return send(res, 200, { id: "m1" });
  }

  if (req.method === "GET" && url.pathname.endsWith("/message")) {
    const now = Date.now();
    if (session.toolStepFinal) {
      const finalComplete = now >= session.finalAt;
      const firstAssistantInfo = { role: "assistant", time: { created: session.createdAt + 1, completed: session.createdAt + 2 } };
      const secondAssistantInfo = { role: "assistant", time: { created: session.createdAt + 3 } };
      const secondAssistantParts = finalComplete
        ? [
            { type: "step-start" },
            { type: "text", text: session.finalResponse },
            { type: "step-finish" }
          ]
        : [];
      if (finalComplete) secondAssistantInfo.time.completed = now;
      return send(res, 200, [
        { info: { role: "user" }, parts: [{ type: "text", text: session.prompt || "" }] },
        {
          info: firstAssistantInfo,
          parts: [
            { type: "step-start" },
            { type: "text", text: session.response || "" },
            { type: "tool", id: "read-1" },
            { type: "tool", id: "read-2" },
            { type: "step-finish" }
          ]
        },
        { info: secondAssistantInfo, parts: secondAssistantParts }
      ]);
    }

    let assistantText = "";
    let completed = false;
    if (session.finalResponse) {
      if (now >= session.finalAt) {
        assistantText = session.finalResponse;
        completed = true;
      } else if (now >= session.readyAt) {
        assistantText = session.response || "";
      }
    } else if (now >= session.readyAt) {
      assistantText = session.response || "";
      completed = true;
    }
    const assistantInfo = { role: "assistant", time: { created: session.createdAt } };
    if (completed) assistantInfo.time.completed = now;
    const assistantParts = assistantText
      ? [{ type: "text", text: assistantText }]
      : [];
    return send(res, 200, [
      { info: { role: "user" }, parts: [{ type: "text", text: session.prompt || "" }] },
      { info: assistantInfo, parts: assistantParts }
    ]);
  }

  if (req.method === "DELETE") {
    sessions.delete(sid);
    return send(res, 200, {});
  }

  return send(res, 404, { error: "not found" });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log("opencode server listening on http://127.0.0.1:" + address.port);
});
`, "utf-8");
    chmodSync(opencodePath, 0o755);
  }

  if (mcps) {
    writeFileSync(mcpPath, `#!/usr/bin/env node
const name = process.env.FAKE_MCP_NAME || "fake";
let buffer = "";
let initialized = false;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } } });
    } else if (msg.method === "notifications/initialized") {
      initialized = true;
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "Echo from " + name, inputSchema: { type: "object", properties: { value: { type: "string" } } } }
      ] } });
    } else if (msg.method === "tools/call") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: name + ":" + msg.params.name + ":" + msg.params.arguments.value + ":initialized=" + initialized }] } });
    } else if (msg.method === "shutdown") {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
      process.exit(0);
    }
  }
});
`, "utf-8");
    chmodSync(mcpPath, 0o755);
  }

  return {
    root,
    home,
    configPath,
    opencodePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function awaitableMkdir(path) {
  mkdirSync(path, { recursive: true });
}

function createServer(fix, extraEnv = {}, timeoutMs = 30_000) {
  if (!existsSync(SERVER)) throw new Error(`Server not found: ${SERVER}`);

  const env = {
    ...process.env,
    DEBUG: "",
    HOME: fix.home,
    OPENCODE_CONFIG: fix.configPath,
    OPENCODE_BIN: fix.opencodePath,
    OPENCODE_TOOL_TIMEOUT_MS: "3000",
    OPENCODE_PROXY_TIMEOUT_MS: "3000",
    OPENCODE_POLL_INTERVAL_MS: "20",
    ...extraEnv,
  };

  const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"], env, timeout: timeoutMs });

  function send(msg) {
    return new Promise((resolve) => {
      const json = JSON.stringify(msg) + "\n";
      if (VERBOSE) console.error(">>>", json.trim());
      proc.stdin.write(json, () => resolve());
    });
  }

  function waitForResponse(id, timeout = 10_000) {
    return new Promise((resolve) => {
      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.id === id) {
              proc.stdout.removeListener("data", onData);
              if (VERBOSE) console.error("<<<", JSON.stringify(parsed));
              resolve(parsed);
              return;
            }
          } catch {}
        }
      };
      proc.stdout.on("data", onData);
      setTimeout(() => {
        proc.stdout.removeListener("data", onData);
        resolve(null);
      }, timeout);
    });
  }

  function waitForBanner(timeout = 5000) {
    return new Promise((resolve) => {
      const onData = (chunk) => {
        if (chunk.toString().includes("Ready.")) {
          proc.stderr.removeListener("data", onData);
          resolve();
        }
      };
      proc.stderr.on("data", onData);
      setTimeout(resolve, timeout);
    });
  }

  function cleanup() {
    proc.kill();
  }

  return { proc, send, waitForResponse, waitForBanner, cleanup };
}

async function withServer(fix, fn, extraEnv) {
  const srv = createServer(fix, extraEnv);
  try {
    await srv.waitForBanner();
    await srv.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } });
    const init = await srv.waitForResponse(1);
    await fn(srv, init);
  } finally {
    srv.cleanup();
    await new Promise(r => setTimeout(r, 100));
  }
}

async function run() {
  console.log("\nopencode-mcp test suite\n");

  {
    console.log("[0] package and runtime versions match");
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    const source = readFileSync(SERVER, "utf-8");
    const runtimeVersion = source.match(/const VERSION = "([^"]+)"/)?.[1];
    assert(runtimeVersion === pkg.version, "runtime VERSION matches package.json version");
  }

  {
    console.log("[1] initializes without an opencode binary");
    const fix = fixture({ opencode: false });
    try {
      await withServer(fix, async (_srv, init) => {
        assert(init?.result?.protocolVersion === "2024-11-05", "initialize returns protocol version");
        assert(init?.result?.serverInfo?.name === "opencode-mcp", "server info name is opencode-mcp");
        assert(init?.result?.capabilities?.tools, "capabilities includes tools");
        assert(!init?.error, "initialize has no error");
      }, { OPENCODE_BIN: join(fix.root, "missing-opencode") });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[2] exposes opencode tool schema");
    const fix = fixture();
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const res = await srv.waitForResponse(2);
        const tool = res?.result?.tools?.find(t => t.name === "opencode");
        const jobTool = res?.result?.tools?.find(t => t.name === "opencode_job");
        const names = res?.result?.tools?.map(t => t.name) || [];
        assert(!!tool, "opencode tool is listed");
        assert(!!jobTool, "opencode_job tool is listed");
        assert(!!tool?.inputSchema?.properties?.agent, "schema supports agent");
        assert(!!tool?.inputSchema?.properties?.mode, "schema supports mode");
        assert(!!tool?.inputSchema?.properties?.model, "schema supports model");
        assert(!!tool?.inputSchema?.properties?.background, "schema supports background jobs");
        assert(!!tool?.inputSchema?.properties?.wait_ms, "schema supports synchronous wait budget");
        assert(!tool?.inputSchema?.properties?.agent?.enum, "agent names are not hardcoded as schema enum");
        assert(names.includes("opencode_model_deepseek"), "dynamic DeepSeek provider tool is listed");
        assert(names.includes("opencode_model_google"), "dynamic Google provider tool is listed");
        assert(names.includes("opencode_model_gemini"), "dynamic Gemini family tool is listed");
        assert(names.includes("opencode_model_claude"), "dynamic Claude family tool is listed");
        assert(names.includes("opencode_model_gpt"), "dynamic GPT family tool is listed");
        assert(names.includes("opencode_model_minimax"), "dynamic MiniMax provider tool is listed");
      });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[3] lists agents from config dynamically");
    const fix = fixture({ opencode: false });
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opencode", arguments: { list: "agents" } } });
        const res = await srv.waitForResponse(2);
        const text = res?.result?.content?.[0]?.text || "";
        assert(text.includes("scout"), "agents list includes fixture agent scout");
        assert(text.includes("builder"), "agents list includes fixture agent builder");
        assert(!res?.error, "list:agents returns a tool result, not JSON-RPC error");
      }, { OPENCODE_BIN: join(fix.root, "missing-opencode") });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[4] returns MCP tool errors without JSON-RPC result/error mixing");
    const fix = fixture({ opencode: false });
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opencode", arguments: {} } });
        const missing = await srv.waitForResponse(2);
        assert(missing?.result?.isError === true, "missing args uses isError");
        assert(!missing?.error, "missing args has no JSON-RPC error");

        await srv.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "opencode", arguments: { agent: "missing", prompt: "hi" } } });
        const unknownAgent = await srv.waitForResponse(3);
        assert(unknownAgent?.result?.isError === true, "unknown agent uses isError");
        assert(!("error" in unknownAgent && "result" in unknownAgent), "unknown agent does not mix error and result");

        await srv.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "missing-tool", arguments: {} } });
        const unknownTool = await srv.waitForResponse(4);
        assert(unknownTool?.error?.code === -32601, "unknown tool returns JSON-RPC error");
        assert(!unknownTool?.result, "unknown tool has no result");
      }, { OPENCODE_BIN: join(fix.root, "missing-opencode") });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[5] resolves short model queries from opencode models");
    const fix = fixture();
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opencode", arguments: { list: "models" } } });
        const listed = await srv.waitForResponse(2);
        const listText = listed?.result?.content?.[0]?.text || "";
        assert(listText.includes("deepseek/deepseek-chat"), "models list includes fake DeepSeek model");
        assert(listText.includes("gemini"), "models list includes discoverable short queries");

        await srv.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "opencode", arguments: { model: "deepseek", prompt: "hi" } } });
        const deepseek = await srv.waitForResponse(3);
        assert(deepseek?.result?.content?.[0]?.text?.includes("model=deepseek/deepseek-chat"), "model=deepseek resolves to available DeepSeek model");

        await srv.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "opencode", arguments: { model: "gemini", prompt: "hi" } } });
        const gemini = await srv.waitForResponse(4);
        assert(gemini?.result?.content?.[0]?.text?.includes("gemini"), "model=gemini resolves to available Gemini model");

        await srv.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "opencode", arguments: { model: "minimax", prompt: "hi" } } });
        const minimax = await srv.waitForResponse(5);
        assert(minimax?.result?.content?.[0]?.text?.includes("model=minimax/MiniMax-M3"), "model=minimax resolves to available MiniMax model");

        await srv.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "opencode", arguments: { model: "claude", prompt: "hi" } } });
        const claude = await srv.waitForResponse(6);
        assert(claude?.result?.content?.[0]?.text?.includes("model=anthropic/claude-sonnet-4-5"), "model=claude resolves to available Claude Sonnet model");

        await srv.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "opencode_model_deepseek", arguments: { prompt: "hi" } } });
        const deepseekTool = await srv.waitForResponse(7);
        const deepseekText = deepseekTool?.result?.content?.[0]?.text || "";
        assert(deepseekText.includes("model=deepseek/deepseek-chat"), "dynamic DeepSeek tool calls best provider model");
        assert(deepseekText.includes("opencode-mcp-empty-"), "dynamic provider tools default to no project context");

        await srv.send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "opencode_model_deepseek", arguments: { model: "reasoner", prompt: "hi", context: "cwd" } } });
        const reasonerTool = await srv.waitForResponse(8);
        const reasonerText = reasonerTool?.result?.content?.[0]?.text || "";
        assert(reasonerText.includes("model=deepseek/deepseek-reasoner"), "dynamic provider tool accepts model query within provider");
        assert(!reasonerText.includes("opencode-mcp-empty-"), "context=cwd disables empty context default");

        await srv.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "opencode_model_claude", arguments: { prompt: "hi" } } });
        const claudeTool = await srv.waitForResponse(9);
        assert(claudeTool?.result?.content?.[0]?.text?.includes("model=anthropic/claude-sonnet-4-5"), "dynamic Claude family tool resolves to Anthropic Claude model");
      });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[6] supports alias tool modes");
    const fix = fixture();
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const res = await srv.waitForResponse(2);
        const names = res?.result?.tools?.map(t => t.name) || [];
        assert(!names.some(n => n.startsWith("opencode_model_")), "OPENCODE_ALIAS_TOOLS=off disables dynamic model tools");
      }, { OPENCODE_ALIAS_TOOLS: "off" });
    } finally {
      fix.cleanup();
    }

    const modelFix = fixture();
    try {
      await withServer(modelFix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const res = await srv.waitForResponse(2);
        const names = res?.result?.tools?.map(t => t.name) || [];
        assert(names.includes("opencode_model_deepseek_deepseek-chat"), "OPENCODE_ALIAS_TOOLS=models exposes per-model tools");
      }, { OPENCODE_ALIAS_TOOLS: "models" });
    } finally {
      modelFix.cleanup();
    }
  }

  {
    console.log("\n[7] resolves dynamic modes from config");
    const fix = fixture();
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opencode", arguments: { mode: "sco", prompt: "hi" } } });
        const res = await srv.waitForResponse(2);
        assert(res?.result?.content?.[0]?.text?.includes("agent=scout"), "mode=sco resolves to scout dynamically");
      });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[8] proxies child MCPs and handles tool name collisions");
    const fix = fixture({ mcps: true });
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const listed = await srv.waitForResponse(2);
        const names = listed?.result?.tools?.map(t => t.name) || [];
        assert(names.includes("echo"), "first child MCP tool keeps original name");
        assert(names.includes("beta_echo"), "second colliding child MCP tool is prefixed");

        await srv.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "beta_echo", arguments: { value: "ok" } } });
        const called = await srv.waitForResponse(3);
        assert(called?.result?.content?.[0]?.text === "beta:echo:ok:initialized=true", "prefixed tool forwards to original child tool after initialized notification");
      });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[9] returns pollable jobs before client timeouts");
    const fix = fixture();
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opencode_model_deepseek", arguments: { model: "chat", prompt: "slow-response please", wait_ms: 60 } } });
        const started = await srv.waitForResponse(2);
        const startedText = started?.result?.content?.[0]?.text || "";
        const jobId = startedText.match(/job_id: (\S+)/)?.[1];
        assert(startedText.includes("Opencode job is still running."), "slow model call returns running job instead of blocking");
        assert(!!jobId, "running job response includes job_id");

        await new Promise(r => setTimeout(r, 220));
        await srv.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "opencode_job", arguments: { action: "status", job_id: jobId, wait_ms: 500 } } });
        const completed = await srv.waitForResponse(3);
        const completedText = completed?.result?.content?.[0]?.text || "";
        assert(completedText.includes("model=deepseek/deepseek-chat"), "opencode_job status returns completed model output");

        await srv.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "opencode_job", arguments: { action: "list" } } });
        const listed = await srv.waitForResponse(4);
        const listedText = listed?.result?.content?.[0]?.text || "";
        assert(listedText.includes('"jobs": []'), "completed job is removed from job list");
      }, { OPENCODE_MCP_RETURN_TIMEOUT_MS: "1000" });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[10] returns a pollable job while async message execution continues");
    const fix = fixture();
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opencode_model_deepseek", arguments: { model: "chat", prompt: "slow-submit please", wait_ms: 60 } } });
        const started = await srv.waitForResponse(2);
        const startedText = started?.result?.content?.[0]?.text || "";
        const jobId = startedText.match(/job_id: (\S+)/)?.[1];
        assert(startedText.includes("Opencode job is still running."), "slow async message returns running job instead of API timeout");
        assert(!!jobId, "slow submit response includes job_id");

        await new Promise(r => setTimeout(r, 240));
        await srv.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "opencode_job", arguments: { action: "status", job_id: jobId, wait_ms: 500 } } });
        const completed = await srv.waitForResponse(3);
        const completedText = completed?.result?.content?.[0]?.text || "";
        assert(completedText.includes("model=deepseek/deepseek-chat"), "opencode_job status returns completed output after slow submit");
      }, {
        OPENCODE_API_TIMEOUT_MS: "50",
        OPENCODE_MESSAGE_TIMEOUT_MS: "500",
        OPENCODE_MCP_RETURN_TIMEOUT_MS: "1000",
      });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[11] does not complete jobs on stable partial assistant output");
    const fix = fixture();
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opencode_model_deepseek", arguments: { model: "chat", prompt: "partial-then-final please", wait_ms: 60 } } });
        const started = await srv.waitForResponse(2);
        const startedText = started?.result?.content?.[0]?.text || "";
        const jobId = startedText.match(/job_id: (\S+)/)?.[1];
        assert(startedText.includes("Opencode job is still running."), "partial model call returns a running job");
        assert(!!jobId, "partial model response includes job_id");

        await srv.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "opencode_job", arguments: { action: "status", job_id: jobId, wait_ms: 120 } } });
        const partial = await srv.waitForResponse(3);
        const partialText = partial?.result?.content?.[0]?.text || "";
        assert(partialText.includes("Opencode job is still running."), "stable partial output remains pollable");
        assert(partialText.includes("PARTIAL: still investigating"), "partial output is reported as latest partial");

        await new Promise(r => setTimeout(r, 260));
        await srv.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "opencode_job", arguments: { action: "status", job_id: jobId, wait_ms: 500 } } });
        const completed = await srv.waitForResponse(4);
        const completedText = completed?.result?.content?.[0]?.text || "";
        assert(completedText.includes("FINAL: model=deepseek/deepseek-chat complete"), "final output is returned after completion signal");

        await srv.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "opencode_job", arguments: { action: "status", job_id: jobId, wait_ms: 50 } } });
        const cached = await srv.waitForResponse(5);
        const cachedText = cached?.result?.content?.[0]?.text || "";
        assert(cachedText.includes("FINAL: model=deepseek/deepseek-chat complete"), "completed output is cached for repeat polls");
      }, { OPENCODE_MCP_RETURN_TIMEOUT_MS: "1000" });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[12] ignores completed interim tool-step assistant turns");
    const fix = fixture();
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opencode_model_deepseek", arguments: { model: "chat", prompt: "tool-step-final please", wait_ms: 60 } } });
        const started = await srv.waitForResponse(2);
        const startedText = started?.result?.content?.[0]?.text || "";
        const jobId = startedText.match(/job_id: (\S+)/)?.[1];
        assert(startedText.includes("Opencode job is still running."), "tool-step call returns a running job");
        assert(!!jobId, "tool-step response includes job_id");

        await srv.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "opencode_job", arguments: { action: "status", job_id: jobId, wait_ms: 120 } } });
        const interim = await srv.waitForResponse(3);
        const interimText = interim?.result?.content?.[0]?.text || "";
        assert(interimText.includes("Opencode job is still running."), "completed interim tool step remains pollable");
        assert(!interimText.includes("Let me inspect the requested files."), "completed interim tool step is not returned as final output");

        await new Promise(r => setTimeout(r, 260));
        await srv.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "opencode_job", arguments: { action: "status", job_id: jobId, wait_ms: 500 } } });
        const completed = await srv.waitForResponse(4);
        const completedText = completed?.result?.content?.[0]?.text || "";
        assert(completedText.includes("FINAL_TOOL_STEP: scenario runner is pnpm run test:scenario"), "final assistant turn is returned after tool-step sequence");
      }, { OPENCODE_MCP_RETURN_TIMEOUT_MS: "1000" });
    } finally {
      fix.cleanup();
    }
  }

  {
    console.log("\n[13] shutdown");
    const fix = fixture();
    try {
      await withServer(fix, async (srv) => {
        await srv.send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: {} });
        const res = await srv.waitForResponse(2);
        assert(res?.result === null, "shutdown returns null");
        assert(!res?.error, "shutdown has no error");
      });
    } finally {
      fix.cleanup();
    }
  }

  const total = passed + failed;
  console.log(`\n${passed}/${total} tests passed`);
  if (errors.length > 0) {
    console.log("\nFailures:");
    for (const error of errors) console.log(`  - ${error}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Suite error:", e);
  process.exit(1);
});
