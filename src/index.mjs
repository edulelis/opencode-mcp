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
 *   OPENCODE_POLL_INTERVAL_MS session polling interval       (default: 2000)
 *   OPENCODE_INCLUDE_REASONING include reasoning parts        (default: off)
 *   OPENCODE_ALIAS_TOOLS     off|providers|models            (default: providers)
 *   DEBUG                     set "1" for verbose logs
 */

import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ─── Config ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_DEBUG = !!process.env.DEBUG;
const VERSION = "5.3.0";
const log = IS_DEBUG ? (...args) => console.error("[obridge]", ...args) : () => {};

function findOpencode() {
  if (Object.prototype.hasOwnProperty.call(process.env, "OPENCODE_BIN")) {
    return process.env.OPENCODE_BIN && existsSync(process.env.OPENCODE_BIN) ? process.env.OPENCODE_BIN : null;
  }
  for (const p of [
    join(homedir(), ".opencode", "bin", "opencode"),
    join(homedir(), ".local", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode",
  ]) if (existsSync(p)) return p;
  try { return execFileSync("which", ["opencode"], { encoding: "utf-8" }).trim(); } catch { return null; }
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
const MODEL_CACHE_MS = parseInt(process.env.OPENCODE_MODEL_CACHE_MS) || 60_000;
const POLL_INTERVAL = parseInt(process.env.OPENCODE_POLL_INTERVAL_MS) || 2_000;
const INCLUDE_REASONING = process.env.OPENCODE_INCLUDE_REASONING === "1";
const ALIAS_TOOLS = normalizeName(process.env.OPENCODE_ALIAS_TOOLS || "providers");

const AGENTS = CFG.agent
  ? Object.entries(CFG.agent).map(([n, d]) => ({ name: n, description: (d.description || n).split("\n")[0].slice(0, 120), model: d.model || "default" }))
  : [];

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeToolName(value) {
  const safe = normalizeName(value).replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "model";
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
        const finish = (ready) => {
          if (initResolved) return;
          initResolved = true;
          this.ready = !!ready;
          this.failed = !ready;
          if (!ready) this.stop();
          resolve();
        };

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
            } catch (e) {
              log(`Ignoring non-JSON output from MCP "${this.name}": ${e.message}`);
            }
          }
        });

        proc.stderr.on("data", (chunk) => {
          log(`MCP "${this.name}" stderr: ${chunk.toString().trim()}`);
        });
        proc.on("error", (err) => {
          this.failed = true;
          for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(err);
          }
          this.pending.clear();
          finish(false);
        });
        proc.on("exit", (code) => {
          this.ready = false;
          this.failed = true;
          const err = new Error(`MCP "${this.name}" exited with code ${code}`);
          for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(err);
          }
          this.pending.clear();
          finish(false);
        });

        // Send initialize
        this._send({ jsonrpc: "2.0", id: this._nextId(), method: "initialize", params: {
          protocolVersion: "2024-11-05", capabilities: {},
          clientInfo: { name: "opencode-mcp-hub", version: VERSION },
        }});

        // Wait for initialize response, then list tools
        const timeout = setTimeout(() => {
          finish(false);
        }, 10000);

        // Override _handleMessage temporarily to catch init
        const origHandler = this._handleMessage.bind(this);
        this._handleMessage = (msg) => {
          if (msg.id === 1 && msg.result) {
            // Init done — notify readiness, then list tools.
            this._send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
            this._send({ jsonrpc: "2.0", id: this._nextId(), method: "tools/list", params: {} });
          }
          if (msg.id === 2 && msg.result) {
            this.tools = msg.result.tools || [];
            clearTimeout(timeout);
            this._handleMessage = origHandler;
            finish(true);
          }
          if ((msg.id === 1 || msg.id === 2) && msg.error) {
            clearTimeout(timeout);
            this._handleMessage = origHandler;
            finish(false);
          }
          origHandler(msg);
        };

      } catch (err) {
        finish(false);
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
    if (!this.ready || this.proc?.exitCode != null) {
      throw new Error(`MCP "${this.name}" is not available`);
    }
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
      setTimeout(() => {
        if (this.proc?.exitCode == null) this.proc?.kill();
      }, 1000);
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
    this._openServerExitCode = null;
    this._modelCache = { at: 0, text: "", models: [] };
    this._modelAliasTools = [];
    this._modelToolBackend = {};
    this._modelToolCacheKey = "";
    this._emptyContextDir = null;

    // Proxied MCP backends
    this._mcpClients = []; // MCPClient[]
    this._proxiedTools = [];
    this._toolBackend = {}; // exposed tool name -> { clientName, originalName }
    this._hubReady = false;
  }

  // ── Backend: opencode serve ───────────────────────────────────────

  async _ensureOpencode() {
    if (this._openServerUrl) return;
    if (this._openServerStarting) return this._openServerStarting;
    if (!OPENCODE_BIN) {
      throw new Error("opencode binary not found. Install it with: curl -fsSL https://opencode.ai/install | sh");
    }

    log("Starting opencode serve...");
    this._openServerStarting = new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(OPENCODE_BIN, ["serve", "--port=0", "--hostname=127.0.0.1"], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" },
      });
      let out = "";
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this._openServerStarting = null;
        try {
          if (proc.exitCode == null) proc.kill();
        } catch {}
        reject(err);
      };
      const onData = (chunk) => {
        if (this._openServerUrl) return;
        out += chunk.toString();
        const m = out.match(/opencode server listening on (https?:\/\/[^\s]+)/);
        if (m) {
          settled = true;
          this._openServerUrl = m[1];
          this._openServerProc = proc;
          this._openServerExitCode = null;
          this._openServerStarting = null;
          log("Opencode ready:", this._openServerUrl);
          resolve();
        }
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("exit", (code) => {
        if (!settled) {
          fail(new Error(`Opencode exited before it was ready with code ${code}`));
          return;
        }
        this._openServerExitCode = code;
        this._openServerProc = null;
        this._openServerUrl = null;
      });
      proc.on("error", fail);
      setTimeout(() => {
        if (!settled) fail(new Error("Opencode start timeout"));
      }, 15000);
    });
    return this._openServerStarting;
  }

  _stopOpencode() {
    if (this._openServerProc) { this._openServerProc.kill(); this._openServerProc = null; }
    this._openServerUrl = null;
    this._openServerExitCode = null;
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
    const text = await resp.text().catch(() => "");
    if (!resp.ok) throw new Error(`API ${resp.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }

  _parseModel(modelStr) {
    if (!modelStr) return undefined;
    const idx = modelStr.indexOf("/");
    if (idx === -1) return { providerID: modelStr, modelID: modelStr };
    return { providerID: modelStr.slice(0, idx), modelID: modelStr.slice(idx + 1) };
  }

  _modelsText() {
    if (!OPENCODE_BIN) {
      throw new Error("opencode binary not found. Install it with: curl -fsSL https://opencode.ai/install | sh");
    }
    return execFileSync(OPENCODE_BIN, ["models"], {
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
  }

  _parseModels(text) {
    const matches = text.match(/[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+/g) || [];
    return [...new Set(matches.map(m => m.trim()).filter(Boolean))];
  }

  _modelProvider(model) {
    return String(model || "").split("/")[0] || "";
  }

  _modelID(model) {
    const idx = String(model || "").indexOf("/");
    return idx === -1 ? "" : String(model).slice(idx + 1);
  }

  _modelFamily(model) {
    const family = this._modelID(model).split(/[^A-Za-z0-9]+/).find(Boolean);
    const normalized = sanitizeToolName(family);
    return normalized && /[a-z]/.test(normalized) && normalized.length >= 3 ? normalized : "";
  }

  _availableModels(force = false) {
    const now = Date.now();
    if (!force && this._modelCache.models.length && now - this._modelCache.at < MODEL_CACHE_MS) {
      return this._modelCache;
    }
    const text = this._modelsText();
    const models = this._parseModels(text);
    this._modelCache = { at: now, text, models };
    return this._modelCache;
  }

  _scoreModel(model, query) {
    const lower = model.toLowerCase();
    const [provider, modelID = ""] = lower.split("/");
    const q = query.toLowerCase();

    let score = 0;
    if (provider === q) score += 600;
    if (modelID === q) score += 500;
    if (provider.includes(q)) score += 300;
    if (modelID.includes(q)) score += 250;
    if (lower.includes(q)) score += 100;
    if (!lower.includes("-free")) score += 20;
    if (lower.includes("latest")) score += 12;
    if (lower.includes("flash") || lower.includes("highspeed")) score += 8;
    if (lower.includes("chat") || lower.includes("sonnet") || lower.includes("m3")) score += 6;
    if ((q === "deepseek" || q === "chat") && lower.includes("chat")) score += 30;
    if ((q === "claude" || q === "anthropic") && lower.includes("sonnet")) score += 60;
    if ((q === "claude" || q === "anthropic") && lower.includes("opus")) score += 40;
    if ((q === "openai" || q === "gpt") && !lower.includes("mini")) score += 20;
    if (q === "minimax" && lower.includes("m3")) score += 20;
    return score;
  }

  _resolveModelFromList(modelStr, models) {
    const wanted = String(modelStr || "").trim();
    if (!wanted) return wanted;
    const lower = wanted.toLowerCase();

    const exact = models.find(m => m.toLowerCase() === lower);
    if (exact) return exact;
    if (wanted.includes("/")) return wanted;

    const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
    const candidates = models.filter((m) => {
      const ml = m.toLowerCase();
      const provider = ml.split("/")[0];
      return provider === lower || ml.includes(lower) || (tokens.length > 1 && tokens.every(t => ml.includes(t)));
    });

    if (!candidates.length) return wanted;
    return candidates
      .map(m => ({ model: m, score: this._scoreModel(m, lower) }))
      .sort((a, b) => b.score - a.score || a.model.localeCompare(b.model))[0].model;
  }

  _resolveModelAlias(modelStr) {
    const wanted = String(modelStr || "").trim();
    if (!wanted || wanted.includes("/")) return wanted;
    try {
      return this._resolveModelFromList(wanted, this._availableModels().models);
    } catch (e) {
      return wanted;
    }
  }

  _formatModelsList() {
    const { text, models } = this._availableModels(true);
    const noisyAliases = new Set(["free", "preview", "latest"]);
    const discoveredAliases = [...new Set(models.flatMap((m) => {
      const [provider, modelID = ""] = m.split("/");
      return [provider, ...modelID.split(/[^A-Za-z0-9]+/)]
        .map(s => s.toLowerCase())
        .filter(s => s && s.length >= 3 && /[a-z]/.test(s) && !noisyAliases.has(s));
    }))].sort((a, b) => a.localeCompare(b));

    if (!discoveredAliases.length) return text;
    return `${text.trim()}\n\n# You can also use short model queries\n${discoveredAliases.slice(0, 80).join(", ")}\n`;
  }

  _emptyContextDirectory() {
    if (!this._emptyContextDir || !existsSync(this._emptyContextDir)) {
      this._emptyContextDir = mkdtempSync(join(tmpdir(), "opencode-mcp-empty-"));
    }
    return this._emptyContextDir;
  }

  _resolveDirectory(directory, context, defaultContext = "cwd") {
    if (directory) return directory;
    const selected = normalizeName(context || defaultContext);
    return selected === "none" ? this._emptyContextDirectory() : process.cwd();
  }

  _uniqueModelToolName(baseName) {
    let name = baseName;
    let i = 2;
    while (name === "opencode" || this._toolBackend[name] || this._modelToolBackend[name]) {
      name = `${baseName}_${i++}`;
    }
    return name;
  }

  _modelToolSchema(defaultContext = "none") {
    return {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "The prompt to send to this model/provider." },
        model: { type: "string", description: "Optional model ID or short query within this provider/family." },
        context: { type: "string", enum: ["none", "cwd"], default: defaultContext, description: "Use no project context or the current working directory." },
        directory: { type: "string", description: "Explicit working directory. Overrides context when provided." },
      },
    };
  }

  _buildProviderAliasTools(models) {
    const groups = new Map();
    const add = (key, model) => {
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      if (!groups.get(key).includes(model)) groups.get(key).push(model);
    };

    for (const model of models) {
      const provider = this._modelProvider(model);
      const providerKey = sanitizeToolName(provider);
      const familyKey = this._modelFamily(model);
      add(providerKey, model);
      if (familyKey && familyKey !== providerKey) add(familyKey, model);
    }

    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([alias, providerModels]) => {
        const name = this._uniqueModelToolName(`opencode_model_${alias}`);
        this._modelToolBackend[name] = { provider: alias, models: providerModels, fixedModel: null };
        const modelList = providerModels.slice(0, 12).map(m => `- ${m}`).join("\n");
        const more = providerModels.length > 12 ? `\n- ... ${providerModels.length - 12} more` : "";
        return {
          name,
          description:
            `Call ${alias} models through opencode with no project context by default.\n\n` +
            `Available models:\n${modelList}${more}\n\n` +
            `Use this when the user asks for ${alias} or one of these models. ` +
            `Pass "model" to select a specific model/query inside this provider or family.`,
          inputSchema: this._modelToolSchema("none"),
        };
      });
  }

  _buildModelAliasTools(models) {
    return models
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((model) => {
        const safe = sanitizeToolName(model);
        const name = this._uniqueModelToolName(`opencode_model_${safe}`);
        this._modelToolBackend[name] = { provider: this._modelProvider(model), models: [model], fixedModel: model };
        return {
          name,
          description: `Call ${model} through opencode with no project context by default.`,
          inputSchema: this._modelToolSchema("none"),
        };
      });
  }

  _refreshModelAliasTools(force = false) {
    this._modelAliasTools = [];
    this._modelToolBackend = {};

    if (["off", "false", "0", "none"].includes(ALIAS_TOOLS)) return;
    if (!OPENCODE_BIN) return;

    try {
      const { models } = this._availableModels(force);
      const key = `${ALIAS_TOOLS}:${models.join("|")}`;
      if (!force && key === this._modelToolCacheKey && this._modelAliasTools.length) return;

      this._modelToolCacheKey = key;
      if (ALIAS_TOOLS === "models") {
        this._modelAliasTools = this._buildModelAliasTools(models);
      } else {
        this._modelAliasTools = this._buildProviderAliasTools(models);
      }
    } catch (e) {
      log(`Model alias tools unavailable: ${e.message}`);
      this._modelAliasTools = [];
      this._modelToolBackend = {};
    }
  }

  _resolveProviderModel(backend, requestedModel) {
    if (backend.fixedModel && !requestedModel) return backend.fixedModel;
    if (backend.fixedModel && requestedModel) return this._resolveModelFromList(requestedModel, backend.models);
    const query = requestedModel || backend.provider;
    return this._resolveModelFromList(query, backend.models);
  }

  _resolveAgent(agentName) {
    const wanted = String(agentName || "").trim();
    if (!wanted || !AGENTS.length) return { name: wanted, ambiguous: [], found: true };

    const lower = normalizeName(wanted);
    const exact = AGENTS.find(a => normalizeName(a.name) === lower);
    if (exact) return { name: exact.name, ambiguous: [], found: true };

    const candidates = AGENTS.filter((a) => {
      const name = normalizeName(a.name);
      const desc = normalizeName(a.description);
      return name.includes(lower) || desc.includes(lower);
    });
    if (candidates.length === 1) return { name: candidates[0].name, ambiguous: [], found: true };
    if (candidates.length > 1) return { name: wanted, ambiguous: candidates.map(a => a.name), found: false };
    return { name: wanted, ambiguous: [], found: false };
  }

  async _opencodeCall(agent, model, prompt, directory, context = "cwd") {
    await this._ensureOpencode();
    const dir = this._resolveDirectory(directory, context, "cwd");
    // Session create: directory goes in query params
    const session = await this._api("POST", "/session", { title: `opencode-mcp: ${agent || model || "chat"}` }, { directory: dir });
    const sid = session.id;

    // Message body: agent/model/parts live here per SessionPromptData schema
    const msgBody = {
      parts: [{ type: "text", text: prompt }],
    };
    if (agent) msgBody.agent = agent;
    if (model) {
      const resolvedModel = this._resolveModelAlias(model);
      log(`Resolved model "${model}" -> "${resolvedModel}"`);
      msgBody.model = this._parseModel(resolvedModel);
    }

    await this._api("POST", `/session/${sid}/message`, msgBody, { directory: dir });
    return this._pollSession(sid, prompt);
  }

  async _pollSession(sid, prompt) {
    const start = Date.now();
    let prev = 0, stable = 0, last = "", lastMsgs = null;
    log(`Polling session ${sid} (max ${TOOL_TIMEOUT}ms)...`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    while (Date.now() - start < TOOL_TIMEOUT) {
      // Detect if opencode server process died
      if (this._openServerExitCode != null) {
        const msg = `Opencode server exited with code ${this._openServerExitCode}`;
        log(msg);
        try { await this._api("DELETE", `/session/${sid}`); } catch {}
        return `Error: ${msg}`;
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL));

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
          ? parts.filter(p => (p.type === "text" || (INCLUDE_REASONING && p.type === "reasoning")) && p.text)
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

  _uniqueToolName(baseName) {
    let name = baseName;
    let i = 2;
    while (name === "opencode" || this._toolBackend[name]) {
      name = `${baseName}_${i++}`;
    }
    return name;
  }

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
      const cmdPath = cmd.includes("/")
        ? (existsSync(cmd) ? cmd : null)
        : (() => { try { return execFileSync("which", [cmd], { encoding: "utf-8" }).trim(); } catch { return null; } })();
      if (!cmdPath) {
        log(`MCP "${name}" command "${cmd}" not found, skipping`);
        continue;
      }

      log(`Starting proxied MCP: ${name} (${cmd} ${args.join(" ")})`);
      const client = new MCPClient(name, cmd, args, def.env || {});
      await client.start();

      if (client.ready) {
        this._mcpClients.push(client);
        for (const tool of client.tools) {
          const collides = tool.name === "opencode" || !!this._toolBackend[tool.name];
          const exposedName = this._uniqueToolName(collides ? `${name}_${tool.name}` : tool.name);
          const exposedTool = exposedName === tool.name
            ? tool
            : {
                ...tool,
                name: exposedName,
                description: `[${name}:${tool.name}] ${tool.description || ""}`.trim(),
              };
          this._proxiedTools.push(exposedTool);
          this._toolBackend[exposedName] = { clientName: name, originalName: tool.name };
          if (exposedName !== tool.name) log(`  renamed colliding tool "${tool.name}" -> "${exposedName}"`);
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
        "     { \"mode\": \"<name>\", \"prompt\": \"...\" } also works\n" +
        "  2. CHAT — direct model call, with short queries resolved from opencode models\n" +
        "     { \"model\": \"<provider/model>\", \"prompt\": \"...\" }\n" +
        "  3. LIST — list agents or models\n" +
        "     { \"list\": \"agents\" }  or  { \"list\": \"models\" }\n\n" +
        "Configured agents/modes: " + (AGENTS.length ? AGENTS.map(a => a.name).join(", ") : "none"),
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name from opencode config. Exact or unique partial names are accepted." },
          mode: { type: "string", description: "Alias for agent. Exact or unique partial names are accepted." },
          model: { type: "string", description: "Model in provider/name format, or a short query such as deepseek, gemini, minimax, claude, gpt, flash, pro." },
          prompt: { type: "string", description: "The prompt or task" },
          list: { type: "string", description: "Set to \"agents\" or \"models\"", enum: ["agents", "models"] },
          context: { type: "string", description: "Use no project context or the current working directory.", enum: ["none", "cwd"], default: "cwd" },
          directory: { type: "string", description: "Working directory" },
        },
      },
    };
  }

  get _allTools() {
    return [this._opencodeTool, ...this._modelAliasTools, ...this._proxiedTools];
  }

  // ── JSON-RPC handlers ─────────────────────────────────────────────

  async handle(msg) {
    const { id, method, params } = msg;

    switch (method) {
      case "initialize":
        return this.r(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "opencode-mcp", version: VERSION },
        });

      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      case "tools/list":
        await this._waitForMcps();
        this._refreshModelAliasTools();
        return this.r(id, { tools: this._allTools });

      case "tools/call":
        await this._waitForMcps();
        if (!params?.name) return this.r(id, null, { code: -32602, message: "Missing tool name" });
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
        const { model, prompt, list, directory, context } = args;
        const requestedAgent = args.agent || args.mode;

        if (list === "agents") {
          if (!AGENTS.length) return this.r(id, { content: [{ type: "text", text: "No agents found." }] });
          return this.r(id, { content: [{ type: "text", text: "# Agents\n\n" + AGENTS.map(a => `- **${a.name}**: ${a.description} (model: \`${a.model}\`)`).join("\n") + "\n\nCall: `{ \"agent\": \"<name>\", \"prompt\": \"...\" }` or `{ \"mode\": \"<name>\", \"prompt\": \"...\" }`" }] });
        }
        if (list === "models") {
          try { return this.r(id, { content: [{ type: "text", text: this._formatModelsList() }] }); }
          catch (e) { return this.toolError(id, `Error listing models: ${e.message}`); }
        }
        if (!prompt) return this.toolError(id, "Provide agent+prompt, mode+prompt, model+prompt, or list.");
        if (requestedAgent) {
          const resolvedAgent = this._resolveAgent(requestedAgent);
          if (!resolvedAgent.found) {
            if (resolvedAgent.ambiguous.length) {
              return this.toolError(id, `Agent/mode "${requestedAgent}" is ambiguous. Matches: ${resolvedAgent.ambiguous.join(", ")}`);
            }
            return this.toolError(id, `Agent/mode "${requestedAgent}" not found. Available: ${AGENTS.map(a => a.name).join(", ") || "(opencode will decide if config is unavailable)"}`);
          }
          log(`Run agent: ${resolvedAgent.name}`);
          const result = await this._opencodeCall(resolvedAgent.name, null, prompt, directory, context || "cwd");
          return this.r(id, { content: [{ type: "text", text: result }] });
        }
        if (model) {
          log(`Chat model: ${model}`);
          const result = await this._opencodeCall(null, model, prompt, directory, context || "cwd");
          return this.r(id, { content: [{ type: "text", text: result }] });
        }
        return this.toolError(id, "Provide agent+prompt, mode+prompt, model+prompt, or list.");
      }

      // ── Dynamic opencode model alias tools ───────────────────────
      if (toolName.startsWith("opencode_model_") && !this._modelToolBackend[toolName]) {
        this._refreshModelAliasTools();
      }
      const modelBackend = this._modelToolBackend[toolName];
      if (modelBackend) {
        const { prompt, model, directory, context } = args;
        if (!prompt) return this.toolError(id, "Provide prompt.");
        const resolvedModel = this._resolveProviderModel(modelBackend, model);
        log(`Alias tool "${toolName}" resolved to model: ${resolvedModel}`);
        const result = await this._opencodeCall(null, resolvedModel, prompt, directory, context || "none");
        return this.r(id, { content: [{ type: "text", text: result }] });
      }

      // ── Proxied MCP tool ────────────────────────────────────────
      const backend = this._toolBackend[toolName];
      if (backend) {
        const { clientName: mcpName, originalName } = backend;
        const client = this._mcpClients.find(c => c.name === mcpName);
        if (!client) return this.r(id, null, { code: -32602, message: `Backend "${mcpName}" not available` });

        log(`Forwarding "${toolName}" to MCP "${mcpName}" as "${originalName}"`);
        const result = await client.callTool(originalName, args);
        if (!result) return this.toolError(id, `No response from MCP "${mcpName}"`);
        if (result.error) return this.toolError(id, `MCP "${mcpName}" error: ${JSON.stringify(result.error)}`);
        return this.r(id, result.result || { content: [{ type: "text", text: "(empty)" }] });
      }

      return this.r(id, null, { code: -32601, message: `Unknown tool: ${toolName}` });

    } catch (e) {
      log("Error:", e.message);
      return this.toolError(id, `Error: ${e.message}`);
    }
  }

  async _stopAll() {
    this._stopOpencode();
    for (const c of this._mcpClients) c.stop();
    this._mcpClients = [];
    this._proxiedTools = [];
    this._toolBackend = {};
    this._modelAliasTools = [];
    this._modelToolBackend = {};
    this._mcpsStarted = null;
    if (this._emptyContextDir) {
      try { rmSync(this._emptyContextDir, { recursive: true, force: true }); } catch {}
      this._emptyContextDir = null;
    }
  }

  toolError(id, text) {
    return this.r(id, { content: [{ type: "text", text }], isError: true });
  }

  r(id, result, error) {
    const m = { jsonrpc: "2.0", id };
    if (error) {
      if (typeof error === "object" && error?.code) {
        m.error = error;
      } else {
        const msg = typeof error === "string" ? error : (error?.message || error?.toString?.() || "unknown error");
        m.error = { code: -1, message: msg };
      }
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

// ─── Boot ──────────────────────────────────────────────────────────────────
const mcpList = CFG.mcp ? Object.keys(CFG.mcp).filter(k => CFG.mcp[k].enabled !== false) : [];
const skipSet = new Set((process.env.OPENCODE_MCP_SKIP || "").split(",").map(s => s.trim()).filter(Boolean));
const activeMcps = mcpList.filter(n => !skipSet.has(n));

console.error(`opencode-mcp v${VERSION} — MCP hub`);
console.error(`  opencode:      ${OPENCODE_BIN || "(not found; install opencode for model calls)"}`);
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
