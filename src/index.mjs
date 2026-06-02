#!/usr/bin/env node

/**
 * opencode-mcp — MCP hub that bridges Codex ↔ opencode + all its MCP servers.
 *
 * Reads the `mcp` section from opencode.jsonc, starts every enabled MCP server
 * (e.g. focus, codex), merges their tools, and also exposes the "opencode" tool
 * for calling opencode agents and models directly.
 *
 * Register ONE MCP in Codex — get ALL tools:
 *   codex mcp add opencode-mcp -- node /path/to/src/index.mjs
 *
 * ── Env ────────────────────────────────────────────────────────────────────
 *   OPENCODE_BIN              path to opencode binary        (default: auto-detect)
 *   OPENCODE_CONFIG           path to opencode.jsonc         (default: auto-detect)
 *   OPENCODE_SERVER_PASSWORD  for opencode serve             (default: env value)
 *   OPENCODE_MCP_SKIP         comma-sep MCP names            (default: none)
 *   OPENCODE_TOOL_TIMEOUT_MS  max wait for agent/model calls (default: 600000)
 *   OPENCODE_PROXY_TIMEOUT_MS max wait for proxied MCP tools (default: 300000)
 *   DEBUG                     set "1" for verbose logs
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ─── Config ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_DEBUG = !!process.env.DEBUG;
const log = IS_DEBUG ? (...args) => console.error("[obridge]", ...args) : () => {};

function findOpencode() {
  if (process.env.OPENCODE_BIN && existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN;
  for (const p of [
    join(homedir(), ".opencode", "bin", "opencode"),
    join(homedir(), ".local", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode",
  ]) if (existsSync(p)) return p;
  try { return execSync("which opencode 2>/dev/null", { encoding: "utf-8" }).trim(); } catch { return null; }
}

function findConfig() {
  if (process.env.OPENCODE_CONFIG && existsSync(process.env.OPENCODE_CONFIG)) return process.env.OPENCODE_CONFIG;
  for (const p of [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
  ]) if (existsSync(p)) return p;
  return null;
}

function loadJSONC(filePath) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const cleaned = raw.split("\n").map(line => {
      let s = false, c = null;
      for (let i = 0; i < line.length - 1; i++) {
        const ch = line[i], p = i > 0 ? line[i - 1] : null;
        if (s) { if (ch === c && p !== "\\") s = false; continue; }
        if (ch === '"' || ch === "'") { s = true; c = ch; continue; }
        if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    }).join("\n").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) { if (IS_DEBUG) console.error("[obridge] Config parse error:", e.message); return {}; }
}

const OPENCODE_BIN = findOpencode();
const CONFIG_PATH = findConfig();
const CFG = CONFIG_PATH ? loadJSONC(CONFIG_PATH) : {};
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";
const AUTH = "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64");
const SKIP_MCPS = (process.env.OPENCODE_MCP_SKIP || "").split(",").map(s => s.trim()).filter(Boolean);
const TOOL_TIMEOUT = parseInt(process.env.OPENCODE_TOOL_TIMEOUT_MS) || 600_000;
const PROXY_TIMEOUT = parseInt(process.env.OPENCODE_PROXY_TIMEOUT_MS) || 300_000;

const AGENTS = CFG.agent
  ? Object.entries(CFG.agent).map(([n, d]) => ({ name: n, description: (d.description || n).split("\n")[0].slice(0, 120), model: d.model || "default" }))
  : [];

if (!OPENCODE_BIN) {
  console.error("❌ opencode binary not found. Install: curl -fsSL https://opencode.ai/install | sh");
  process.exit(1);
}

// ─── MCP Client — proxies a child MCP server ───────────────────────────────
class MCPClient {
  constructor(name, command, args, env) {
    this.name = name;
    this.command = command;
    this.args = args || [];
    this.env = env || {};
    this.proc = null;
    this.tools = [];
    this.rpcId = 0;
    this.pending = new Map();
    this.buffer = "";
    this.ready = false;
    this.failed = false;
  }

  async start() {
    return new Promise((resolve) => {
      try {
        const proc = spawn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...this.env },
        });
        this.proc = proc;

        let initResolved = false;

        proc.stdout.on("data", (chunk) => {
          this.buffer += chunk.toString();
          const lines = this.buffer.split("\n");
          this.buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try {
              const msg = JSON.parse(t);
              this._handleMessage(msg);
            } catch {}
          }
        });

        proc.stderr.on("data", () => {}); // ignore stderr
        proc.on("error", (err) => {
          this.failed = true;
          if (!initResolved) { initResolved = true; resolve(); }
        });
        proc.on("exit", () => {
          if (!initResolved) { this.failed = true; initResolved = true; resolve(); }
        });

        // Send initialize
        this._send({ jsonrpc: "2.0", id: this._nextId(), method: "initialize", params: {
          protocolVersion: "2024-11-05", capabilities: {},
          clientInfo: { name: "opencode-mcp-hub", version: "5.1.0" },
        }});

        // Wait for initialize response, then list tools
        const timeout = setTimeout(() => {
          if (!initResolved) { initResolved = true; this.failed = true; resolve(); }
        }, 10000);

        // Override _handleMessage temporarily to catch init
        const origHandler = this._handleMessage.bind(this);
        this._handleMessage = (msg) => {
          if (msg.id === 1 && msg.result) {
            // Init done — now list tools
            this._send({ jsonrpc: "2.0", id: this._nextId(), method: "tools/list", params: {} });
          }
          if (msg.id === 2 && msg.result) {
            this.tools = msg.result.tools || [];
            this.ready = true;
            this.failed = false;
            clearTimeout(timeout);
            initResolved = true;
            this._handleMessage = origHandler;
            // Re-process any buffered messages
            resolve();
          }
          origHandler(msg);
        };

      } catch (err) {
        this.failed = true;
        resolve();
      }
    });
  }

  _nextId() { return ++this.rpcId; }

  _send(msg) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  }

  _handleMessage(msg) {
    // Resolve pending calls
    const pending = this.pending.get(msg.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(msg.id);
      pending.resolve(msg);
    }
  }

  async callTool(name, args) {
    const id = this._nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout calling ${this.name} tool "${name}" after ${PROXY_TIMEOUT}ms`));
      }, PROXY_TIMEOUT);

      this.pending.set(id, { resolve, reject, timeout });
      this._send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    });
  }

  stop() {
    try {
      this._send({ jsonrpc: "2.0", id: this._nextId(), method: "shutdown", params: {} });
      setTimeout(() => this.proc?.kill(), 1000);
    } catch {}
  }
}

// ─── Hub: collects tools from opencode + all child MCPs ────────────────────
class OpencodeHub {
  constructor() {
    this.buffer = "";
    this._stdinEnded = false;

    // Opencode backend
    this._openServerProc = null;
    this._openServerUrl = null;
    this._openServerStarting = null;

    // Proxied MCP backends
    this._mcpClients = []; // MCPClient[]
    this._toolBackend = {}; // toolName -> 'opencode' | 'mcp:<name>'
    this._hubReady = false;
  }

  // ── Backend: opencode serve ───────────────────────────────────────

  async _ensureOpencode() {
    if (this._openServerUrl) return;
    if (this._openServerStarting) return this._openServerStarting;

    log("Starting opencode serve...");
    this._openServerStarting = new Promise((resolve, reject) => {
      const proc = spawn(OPENCODE_BIN, ["serve", "--port=0", "--hostname=127.0.0.1"], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" },
      });
      let out = "";
      const onData = (chunk) => {
        if (this._openServerUrl) return;
        out += chunk.toString();
        const m = out.match(/opencode server listening on (https?:\/\/[^\s]+)/);
        if (m) {
          this._openServerUrl = m[1];
          this._openServerProc = proc;
          this._openServerStarting = null;
          log("Opencode ready:", this._openServerUrl);
          resolve();
        }
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("exit", (code) => { if (!this._openServerUrl) { this._openServerStarting = null; reject(new Error(`Opencode exit ${code}`)); }});
      proc.on("error", (e) => { this._openServerStarting = null; reject(e); });
      setTimeout(() => { if (!this._openServerUrl) { this._openServerStarting = null; reject(new Error("Opencode start timeout")); }}, 15000);
    });
    return this._openServerStarting;
  }

  _stopOpencode() {
    if (this._openServerProc) { this._openServerProc.kill(); this._openServerProc = null; }
    this._openServerUrl = null;
  }

  async _api(method, path, body, queryParams) {
    await this._ensureOpencode();
    let url = this._openServerUrl + path;
    if (queryParams) {
      const qs = new URLSearchParams(queryParams).toString();
      if (qs) url += "?" + qs;
    }
    const resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: AUTH },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 500)}`);
    return resp.json();
  }

  _parseModel(modelStr) {
    if (!modelStr) return undefined;
    const idx = modelStr.indexOf("/");
    if (idx === -1) return { providerID: modelStr, modelID: modelStr };
    return { providerID: modelStr.slice(0, idx), modelID: modelStr.slice(idx + 1) };
  }

  async _opencodeCall(agent, model, prompt, directory) {
    await this._ensureOpencode();
    const dir = directory || process.cwd();
    // Session create: directory goes in query params
    const session = await this._api("POST", "/session", { title: `opencode-mcp: ${agent || model || "chat"}` }, { directory: dir });
    const sid = session.id;

    // Message body: agent/model/parts live here per SessionPromptData schema
    const msgBody = {
      parts: [{ type: "text", text: prompt }],
    };
    if (agent) msgBody.agent = agent;
    if (model) msgBody.model = this._parseModel(model);

    await this._api("POST", `/session/${sid}/message`, msgBody, { directory: dir });
    return this._pollSession(sid, prompt);
  }

  async _pollSession(sid, prompt) {
    const start = Date.now();
    let prev = 0, stable = 0, last = "", lastMsgs = null;
    log(`Polling session ${sid} (max ${TOOL_TIMEOUT}ms)...`);
    await new Promise(r => setTimeout(r, 2000));

    while (Date.now() - start < TOOL_TIMEOUT) {
      // Detect if opencode server process died
      if (this._openServerProc?.exitCode != null) {
        const msg = `Opencode server exited with code ${this._openServerProc.exitCode}`;
        log(msg);
        try { await this._api("DELETE", `/session/${sid}`); } catch {}
        return `Error: ${msg}`;
      }

      await new Promise(r => setTimeout(r, 2000));

      let msgs;
      try {
        msgs = await this._api("GET", `/session/${sid}/message`);
      } catch (e) {
        log(`Poll error: ${e.message}`);
        continue; // transient, retry
      }

      if (!Array.isArray(msgs)) continue;

      // Check for assistant error on any message
      for (const m of msgs) {
        const info = m.info || {};
        if (info.role === "assistant" && info.error) {
          const err = info.error;
          const detail = err.data?.message || err.name || JSON.stringify(err);
          log(`Assistant error: ${detail}`);
          try { await this._api("DELETE", `/session/${sid}`); } catch {}
          return `Error from model: ${detail}`;
        }
      }

      let resp = "";
      for (const m of msgs) {
        const parts = m.parts;
        const t = parts
          ? parts.filter(p => (p.type === "text" || p.type === "reasoning") && p.text)
                 .map(p => p.text.trim()).filter(Boolean).join("\n")
          : (m.content || "");
        if (t && t !== prompt) resp = t;
      }

      // New messages arrived → reset stability
      if (msgs.length > prev) { prev = msgs.length; stable = 0; last = resp; lastMsgs = msgs; continue; }

      // Same message count, content stabilized
      if (resp && resp === last) {
        stable++;
        if (stable >= 3) {
          log(`Session ${sid} stabilized after ${Date.now() - start}ms`);
          break;
        }
      } else if (resp) {
        last = resp;
        stable = 0;
        lastMsgs = msgs;
      }
    }

    try { await this._api("DELETE", `/session/${sid}`); } catch {}
    const elapsed = Date.now() - start;
    if (!last) return `(no response after ${(elapsed / 1000).toFixed(0)}s)`;
    log(`Session ${sid} complete: ${last.length} chars in ${elapsed}ms`);
    return last;
  }

  // ── Backend: proxied MCPs ────────────────────────────────────────

  async _startProxiedMcps() {
    const mcpConfig = CFG.mcp || {};
    const skipSet = new Set(SKIP_MCPS);
    const entries = Object.entries(mcpConfig);
    log(`Proxied MCP config has ${entries.length} entries`);
    for (const [n] of entries) log(`  mcp entry: ${n}`);

    for (const [name, def] of Object.entries(mcpConfig)) {
      if (def.enabled === false) continue;
      if (skipSet.has(name)) { log(`Skipping MCP "${name}" (OPENCODE_MCP_SKIP)`); continue; }

      let cmd, args;
      if (def.type === "local" && def.command) {
        cmd = def.command[0];
        args = def.command.slice(1);
      } else if (def.type === "remote" && def.url) {
        log(`Skipping remote MCP "${name}" (${def.url}) — stdio proxy not supported`);
        continue;
      } else {
        continue;
      }

      // Check if command exists
      const cmdPath = cmd.includes("/") ? cmd : (() => { try { return execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim(); } catch { return null; } })();
      if (!cmdPath && !cmd.includes("/")) {
        log(`MCP "${name}" command "${cmd}" not found, skipping`);
        continue;
      }

      log(`Starting proxied MCP: ${name} (${cmd} ${args.join(" ")})`);
      const client = new MCPClient(name, cmd, args, def.env || {});
      await client.start();

      if (client.ready) {
        this._mcpClients.push(client);
        for (const tool of client.tools) {
          this._toolBackend[tool.name] = `mcp:${name}`;
        }
        log(`  → ${client.tools.length} tools from "${name}"`);
      } else {
        log(`  → MCP "${name}" failed to start, skipping`);
      }
    }
  }

    async _waitForMcps(timeoutMs = 8000) {
      if (!this._mcpsStarted) {
        this._mcpsStarted = this._startProxiedMcps();
      }
      await Promise.race([
        this._mcpsStarted,
        new Promise(r => setTimeout(r, timeoutMs)),
      ]);
    }

    // ── Get all tools (opencode + proxied) ───────────────────────────

  get _opencodeTool() {
    return {
      name: "opencode",
      description:
        "Call opencode agents and models.\n\n" +
        "MODES:\n" +
        "  1. AGENT — runs agent with full directives\n" +
        "     { \"agent\": \"<name>\", \"prompt\": \"...\" }\n" +
        "  2. CHAT — direct model call\n" +
        "     { \"model\": \"<provider/model>\", \"prompt\": \"...\" }\n" +
        "  3. LIST — list agents or models\n" +
        "     { \"list\": \"agents\" }  or  { \"list\": \"models\" }\n\n" +
        "Agents: " + (AGENTS.length ? AGENTS.map(a => a.name).join(", ") : "none"),
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name", enum: AGENTS.length ? AGENTS.map(a => a.name) : undefined },
          model: { type: "string", description: "Model in provider/name format" },
          prompt: { type: "string", description: "The prompt or task" },
          list: { type: "string", description: "Set to \"agents\" or \"models\"", enum: ["agents", "models"] },
          directory: { type: "string", description: "Working directory" },
        },
      },
    };
  }

  get _allTools() {
    const tools = [this._opencodeTool];
    for (const client of this._mcpClients) {
      for (const t of client.tools) tools.push(t);
    }
    return tools;
  }

  // ── JSON-RPC handlers ─────────────────────────────────────────────

  async handle(msg) {
    const { id, method, params } = msg;

    switch (method) {
      case "initialize":
        // Start opencode in background
        this._ensureOpencode().catch(() => {});
        return this.r(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "opencode-mcp", version: "5.1.0" },
        });

      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      case "tools/list":
        await this._waitForMcps();
        return this.r(id, { tools: this._allTools });

      case "tools/call":
        await this._waitForMcps();
        return this._call(id, params.name, params.arguments || {});

      case "shutdown":
        await this._stopAll();
        return this.r(id, null);

      case "exit":
        await this._stopAll();
        process.exit(0);

      default:
        return this.r(id, null, { code: -32601, message: `Unknown: ${method}` });
    }
  }

  async _call(id, toolName, args) {
    try {
      // ── opencode tool ───────────────────────────────────────────
      if (toolName === "opencode") {
        const { agent, model, prompt, list, directory } = args;

        if (list === "agents") {
          if (!AGENTS.length) return this.r(id, { content: [{ type: "text", text: "No agents found." }] });
          return this.r(id, { content: [{ type: "text", text: "# Agents\n\n" + AGENTS.map(a => `- **${a.name}**: ${a.description} (model: \`${a.model}\`)`).join("\n") + "\n\nCall: `{ \"agent\": \"<name>\", \"prompt\": \"...\" }`" }] });
        }
        if (list === "models") {
          try { const out = execSync(`${OPENCODE_BIN} models`, { encoding: "utf-8", timeout: 15000 }); return this.r(id, { content: [{ type: "text", text: out }] }); }
          catch (e) { return this.r(id, { content: [{ type: "text", text: `Error listing models: ${e.message}` }] }, `Model list failed: ${e.message}`); }
        }
        if (!prompt) return this.r(id, { content: [{ type: "text", text: "Provide agent+prompt, model+prompt, or list." }] }, "Missing prompt");
        if (agent) {
          if (AGENTS.length && !AGENTS.find(a => a.name === agent)) return this.r(id, { content: [{ type: "text", text: `Agent "${agent}" not found. Available: ${AGENTS.map(a => a.name).join(", ")}` }] }, `Agent "${agent}" not found`);
          log(`Run agent: ${agent}`);
          const result = await this._opencodeCall(agent, null, prompt, directory);
          return this.r(id, { content: [{ type: "text", text: result }] });
        }
        if (model) {
          log(`Chat model: ${model}`);
          const result = await this._opencodeCall(null, model, prompt, directory);
          return this.r(id, { content: [{ type: "text", text: result }] });
        }
        return this.r(id, { content: [{ type: "text", text: "Provide agent+prompt, model+prompt, or list." }] }, "Missing agent or model");
      }

      // ── Proxied MCP tool ────────────────────────────────────────
      const backend = this._toolBackend[toolName];
      if (backend?.startsWith("mcp:")) {
        const mcpName = backend.slice(4);
        const client = this._mcpClients.find(c => c.name === mcpName);
        if (!client) return this.r(id, null, { code: -32602, message: `Backend "${mcpName}" not available` });

        log(`Forwarding "${toolName}" to MCP "${mcpName}"`);
        const result = await client.callTool(toolName, args);
        if (!result) return this.r(id, { content: [{ type: "text", text: `No response from MCP "${mcpName}"` }] }, `MCP "${mcpName}" returned empty`);
        if (result.error) return this.r(id, { content: [{ type: "text", text: `MCP "${mcpName}" error: ${JSON.stringify(result.error)}` }] }, `MCP "${mcpName}" tool error`);
        return this.r(id, result.result || { content: [{ type: "text", text: "(empty)" }] });
      }

      return this.r(id, null, { code: -32601, message: `Unknown tool: ${toolName}` });

    } catch (e) {
      log("Error:", e.message);
      return this.r(id, { content: [{ type: "text", text: `Error: ${e.message}` }] }, `Tool call failed: ${e.message}`);
    }
  }

  async _stopAll() {
    this._stopOpencode();
    for (const c of this._mcpClients) c.stop();
    this._mcpClients = [];
    this._toolBackend = {};
  }

  r(id, result, error) {
    const m = { jsonrpc: "2.0", id };
    if (error) {
      const msg = typeof error === "string" ? error : (error?.message || error?.toString?.() || "unknown error");
      m.error = { code: -1, message: msg };
      if (result) m.result = result;
    } else {
      m.result = result;
    }
    return m;
  }

  // ── stdio ─────────────────────────────────────────────────────────
  start() {
    let pending = 0;
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t);
          pending++;
          this.handle(msg).then(reply => {
            pending--;
            if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
            if (pending === 0 && this._stdinEnded) this._exit();
          });
        } catch (e) { if (IS_DEBUG) console.error("[obridge] Parse error:", e.message); }
      }
    });
    process.stdin.on("end", () => { this._stdinEnded = true; if (pending === 0) this._exit(); });
    process.stdin.on("error", () => process.exit(1));
  }

  _exit() { this._stopAll(); setTimeout(() => process.exit(0), 100); }
}

// ─── Zombie reaper: kill stale opencode serve processes from previous runs ───
function killStaleOpencode() {
  try {
    // Use ps aux for cross-platform (macOS + Linux)
    const out = execSync(`ps aux | grep "[o]pencode serve" || true`, { encoding: "utf-8" });
    const lines = out.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1]);
      if (pid && pid !== process.pid) {
        try { process.kill(pid, "SIGTERM"); log(`Killed stale opencode serve pid=${pid}`); } catch {}
      }
    }
  } catch {}
}

// ─── Boot ──────────────────────────────────────────────────────────────────
killStaleOpencode();

const mcpList = CFG.mcp ? Object.keys(CFG.mcp).filter(k => CFG.mcp[k].enabled !== false) : [];
const skipSet = new Set((process.env.OPENCODE_MCP_SKIP || "").split(",").map(s => s.trim()).filter(Boolean));
const activeMcps = mcpList.filter(n => !skipSet.has(n));

console.error(`opencode-mcp v5.1.0 — MCP hub`);
console.error(`  opencode:      ${OPENCODE_BIN}`);
console.error(`  agents:        ${AGENTS.length} found`);
console.error(`  tool timeout:  ${(TOOL_TIMEOUT / 1000).toFixed(0)}s`);
console.error(`  proxy timeout: ${(PROXY_TIMEOUT / 1000).toFixed(0)}s`);
console.error(`  proxied MCPs:  ${activeMcps.length > 0 ? activeMcps.join(", ") : "(none)"}`);
console.error(`  debug:         ${IS_DEBUG ? "on" : "off (set DEBUG=1)"}`);
console.error(`Ready. Waiting for MCP messages on stdin...`);

const hub = new OpencodeHub();
hub.start();

// Clean shutdown on signals
process.on("SIGTERM", () => { hub._stopAll(); process.exit(0); });
process.on("SIGINT", () => { hub._stopAll(); process.exit(0); });
process.on("uncaughtException", (err) => {
  console.error("[obridge] Uncaught:", err.message);
  hub._stopAll();
  process.exit(1);
});
