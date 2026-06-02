#!/usr/bin/env node

/**
 * opencode-mcp — MCP server that bridges Codex ↔ opencode.
 *
 * Exposes a single "opencode" tool that lets MCP clients (Codex, Claude Desktop,
 * any MCP host) call opencode agents and models using credentials already
 * configured in opencode — no duplicate API keys needed.
 *
 * ── Install ─────────────────────────────────────────────────────────────────
 *   npx opencode-mcp                  # if published to npm
 *   node src/index.mjs                   # local run
 *   codex mcp add opencode-mcp -- node /path/to/src/index.mjs
 *
 * ── Env ────────────────────────────────────────────────────────────────────
 *   OPENCODE_BIN     path to opencode binary             (default: auto-detect)
 *   OPENCODE_CONFIG  path to opencode.jsonc              (default: auto-detect)
 *   OPENCODE_SERVER_PASSWORD  password for opencode serve (default: env value)
 *   OPENCODE_BRIDGE_PORT      force a specific port       (default: random)
 *   DEBUG                      set "1" for verbose logs
 *
 * ── Protocol ────────────────────────────────────────────────────────────────
 * Implements MCP (Model Context Protocol) via stdio JSON-RPC 2.0.
 * Starts `opencode serve` as a headless subprocess and uses its HTTP API.
 */

// ─── Imports ───────────────────────────────────────────────────────────────
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ─── Helpers: paths ────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_DEBUG = !!process.env.DEBUG;
const log = IS_DEBUG ? (...args) => console.error("[obridge]", ...args) : () => {};

function findOpencode() {
  if (process.env.OPENCODE_BIN && existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN;
  // Common locations
  const candidates = [
    join(homedir(), ".opencode", "bin", "opencode"),
    join(homedir(), ".local", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  // Try PATH
  try { const p = execSync("which opencode 2>/dev/null", { encoding: "utf-8" }).trim(); if (p) return p; } catch {}
  return null;
}

function findConfig() {
  if (process.env.OPENCODE_CONFIG && existsSync(process.env.OPENCODE_CONFIG)) return process.env.OPENCODE_CONFIG;
  const candidates = [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

const OPENCODE_BIN = findOpencode();
const CONFIG_PATH = findConfig();
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";
const AUTH = "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64");

// ─── Load config ───────────────────────────────────────────────────────────
function loadJSONC(filePath) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    const cleaned = lines.map(line => {
      let inString = false, char = null;
      for (let i = 0; i < line.length - 1; i++) {
        const c = line[i], p = i > 0 ? line[i - 1] : null;
        if (inString) { if (c === char && p !== "\\") inString = false; continue; }
        if (c === '"' || c === "'") { inString = true; char = c; continue; }
        if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    });
    return JSON.parse(cleaned.join("\n").replace(/\/\*[\s\S]*?\*\//g, "").trim());
  } catch (e) {
    if (IS_DEBUG) console.error("[obridge] Config parse error:", e.message);
    return {};
  }
}

const CFG = CONFIG_PATH ? loadJSONC(CONFIG_PATH) : {};
const AGENTS = CFG.agent
  ? Object.entries(CFG.agent).map(([n, d]) => ({
      name: n,
      description: (d.description || n).split("\n")[0].slice(0, 120),
      model: d.model || "default",
    }))
  : [];

// ─── Bootstrap check ───────────────────────────────────────────────────────
if (!OPENCODE_BIN) {
  console.error("❌ opencode binary not found.");
  console.error("   Install: curl -fsSL https://opencode.ai/install | sh");
  console.error("   Or set OPENCODE_BIN=/path/to/opencode");
  process.exit(1);
}

// ─── MCP Server ────────────────────────────────────────────────────────────
class OpencodeBridge {
  buffer = "";
  serverProc = null;
  serverUrl = null;
  serverStarting = null;

  get tools() {
    return [{
      name: "opencode",
      description:
        "Call opencode agents and models from any MCP client.\n\n" +
        "MODES:\n" +
        "  1. AGENT — runs an opencode agent with full system prompts & permissions\n" +
        "     { \"agent\": \"<name>\", \"prompt\": \"...\" }\n" +
        "  2. CHAT — direct model call bypassing agent directives\n" +
        "     { \"model\": \"<provider/model>\", \"prompt\": \"...\" }\n" +
        "  3. LIST — list available agents or models\n" +
        "     { \"list\": \"agents\" }  or  { \"list\": \"models\" }\n\n" +
        "Agents: " + (AGENTS.length ? AGENTS.map(a => a.name).join(", ") : "check opencode_config"),
      inputSchema: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "Agent name from opencode config (runs with full directives)",
            enum: AGENTS.length ? AGENTS.map(a => a.name) : undefined,
          },
          model: {
            type: "string",
            description: "Model in provider/name format (e.g. deepseek/deepseek-chat). Direct chat, no agent directives.",
          },
          prompt: {
            type: "string",
            description: "The prompt or task to execute",
          },
          list: {
            type: "string",
            description: "Set to \"agents\" or \"models\" to list available resources",
            enum: ["agents", "models"],
          },
          directory: {
            type: "string",
            description: "Working directory (defaults to CWD)",
          },
        },
      },
    }];
  }

  // ── Server lifecycle ──────────────────────────────────────────────

  ensureServer() {
    if (this.serverUrl) return Promise.resolve();
    if (this.serverStarting) return this.serverStarting;

    if (IS_DEBUG) console.error("[obridge] Starting opencode serve...");
    this.serverStarting = new Promise((resolve, reject) => {
      const args = ["serve", "--port=0", "--hostname=127.0.0.1"];
      const proc = spawn(OPENCODE_BIN, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let out = "";
      const onData = (chunk) => {
        if (this.serverUrl) return;
        out += chunk.toString();
        const m = out.match(/opencode server listening on (https?:\/\/[^\s]+)/);
        if (m) {
          this.serverUrl = m[1];
          this.serverProc = proc;
          this.serverStarting = null;
          if (IS_DEBUG) console.error("[obridge] Server ready:", this.serverUrl);
          resolve();
        }
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("exit", (code) => { if (!this.serverUrl) { this.serverStarting = null; reject(new Error(`Server exit ${code}`)); }});
      proc.on("error", (e) => { this.serverStarting = null; reject(e); });
      setTimeout(() => { if (!this.serverUrl) { this.serverStarting = null; reject(new Error("Server start timeout")); }}, 15000);
    });
    return this.serverStarting;
  }

  stopServer() {
    if (this.serverProc) { this.serverProc.kill(); this.serverProc = null; }
    this.serverUrl = null;
  }

  // ── HTTP client ───────────────────────────────────────────────────

  async api(method, path, body) {
    await this.ensureServer();
    const resp = await fetch(this.serverUrl + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: AUTH },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    return resp.json();
  }

  extractText(msg) {
    if (!msg) return "";
    const parts = msg.parts;
    if (Array.isArray(parts)) return parts.filter(p => p.type === "text" && p.text).map(p => p.text.trim()).filter(Boolean).join("\n");
    return msg.content || "";
  }

  // ── Session execution ─────────────────────────────────────────────

  async createSessionAndRun(agentName, modelName, prompt, directory) {
    await this.ensureServer();
    const body = { directory: directory || process.cwd() };
    if (agentName) body.agent = agentName;
    if (modelName) body.model = modelName;

    const session = await this.api("POST", "/session", body);
    const sid = session.id;
    log("Session:", sid);

    await this.api("POST", `/session/${sid}/message`, { parts: [{ type: "text", text: prompt }] });
    log("Polling...");

    const start = Date.now();
    let prevCount = 0, stable = 0, lastResp = "";

    await new Promise(r => setTimeout(r, 2000));

    while (Date.now() - start < 180000) {
      await new Promise(r => setTimeout(r, 1500));
      const msgs = await this.api("GET", `/session/${sid}/message`);
      if (!Array.isArray(msgs)) continue;

      let resp = "";
      for (const m of msgs) {
        const t = this.extractText(m);
        if (t && t !== prompt) resp = t;
      }

      if (msgs.length > prevCount) { prevCount = msgs.length; stable = 0; lastResp = resp; continue; }
      if (resp && resp === lastResp) { stable++; if (stable >= 3) break; }
      else if (resp) { lastResp = resp; stable = 0; }
    }

    try { await this.api("DELETE", `/session/${sid}`); } catch {}
    return lastResp || "(empty response)";
  }

  // ── JSON-RPC ──────────────────────────────────────────────────────

  async handle(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        this.ensureServer().catch(() => {});
        return this.r(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "opencode-mcp", version: "4.1.0" },
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "tools/list":
        return this.r(id, { tools: this.tools });
      case "tools/call":
        return this.call(id, params.name, params.arguments || {});
      case "shutdown":
        await this.stopServer(); return this.r(id, null);
      case "exit":
        await this.stopServer(); process.exit(0);
      default:
        return this.r(id, null, { code: -32601, message: `Unknown method: ${method}` });
    }
  }

  async call(id, name, args) {
    try {
      if (name !== "opencode") return this.r(id, null, { code: -32601, message: `Unknown tool: ${name}` });

      const { agent, model, prompt, list, directory } = args;

      // List
      if (list === "agents") {
        if (!AGENTS.length) return this.r(id, { content: [{ type: "text", text: "No agents found in opencode config." }] });
        return this.r(id, {
          content: [{ type: "text", text:
            "# Agents\n\n" +
            AGENTS.map(a => `- **${a.name}**: ${a.description} (model: \`${a.model}\`)`).join("\n") + "\n\n" +
            `Call: \`{ "agent": "<name>", "prompt": "..." }\``
          }]
        });
      }

      if (list === "models") {
        try {
          const out = execSync(`${OPENCODE_BIN} models`, { encoding: "utf-8", timeout: 15000 });
          return this.r(id, { content: [{ type: "text", text: out }] });
        } catch (e) {
          return this.r(id, { content: [{ type: "text", text: `Error: ${e.message}` }] }, true);
        }
      }

      // Validate
      if (!prompt) return this.r(id, { content: [{ type: "text", text: "Provide agent+prompt, model+prompt, or list." }] }, true);

      // Run agent
      if (agent) {
        if (AGENTS.length && !AGENTS.find(a => a.name === agent)) {
          return this.r(id, { content: [{ type: "text", text: `Agent "${agent}" not found. Available: ${AGENTS.map(a => a.name).join(", ")}` }] }, true);
        }
        log(`Run agent: ${agent}`);
        const result = await this.createSessionAndRun(agent, null, prompt, directory);
        return this.r(id, { content: [{ type: "text", text: result }] });
      }

      // Direct chat
      if (model) {
        log(`Chat model: ${model}`);
        const result = await this.createSessionAndRun(null, model, prompt, directory);
        return this.r(id, { content: [{ type: "text", text: result }] });
      }

      return this.r(id, { content: [{ type: "text", text: "Provide agent+prompt, model+prompt, or list." }] }, true);

    } catch (e) {
      log("Error:", e.message);
      return this.r(id, { content: [{ type: "text", text: `Error: ${e.message}` }] }, true);
    }
  }

  r(id, result, error) {
    const m = { jsonrpc: "2.0", id };
    if (error) { m.error = { code: -1, message: "error" }; m.result = result; } else m.result = result;
    return m;
  }

  // ── STDIO transport ───────────────────────────────────────────────

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

  _exit() { try { this.stopServer(); } catch {} setTimeout(() => process.exit(0), 100); }
}

// ─── Boot ──────────────────────────────────────────────────────────────────
console.error(`opencode-mcp v4.1.0 — MCP bridge to opencode`);
console.error(`  opencode: ${OPENCODE_BIN}`);
console.error(`  config:   ${CONFIG_PATH || "(none)"}`);
console.error(`  agents:   ${AGENTS.length} found`);
console.error(`  debug:    ${IS_DEBUG ? "on" : "off (set DEBUG=1)"}`);
console.error(`Ready. Waiting for MCP messages on stdin...`);

new OpencodeBridge().start();
