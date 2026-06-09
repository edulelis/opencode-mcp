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
 *   OPENCODE_TOOL_TIMEOUT_MS  max total runtime for agent/model jobs; 0 disables (default: 0)
 *   OPENCODE_MCP_RETURN_TIMEOUT_MS max synchronous wait before returning a pollable job (default: 15000)
 *   OPENCODE_API_TIMEOUT_MS   max wait for one regular opencode HTTP call (default: 10000)
 *   OPENCODE_MESSAGE_TIMEOUT_MS max wait for fallback /message submission; 0 disables (default: 0)
 *   OPENCODE_MCP_STATE_DIR     directory for durable job state (default: ~/.opencode-mcp/state)
 *   OPENCODE_MCP_PRESERVE_JOBS keep active jobs alive when bridge exits (default: 1)
 *   OPENCODE_COMPLETED_JOB_TTL_MS keep completed job output available for repeat polls (default: 600000)
 *   OPENCODE_STABLE_COMPLETION_MS legacy no-completion-signal fallback delay (default: 30000)
 *   OPENCODE_PROGRESS_STALE_MS warn when no model/session progress is observed (default: 120000)
 *   OPENCODE_STALE_TIMEOUT_MS fail and clean up stale jobs after no progress; 0 disables (default: 0)
 *   OPENCODE_PROXY_TIMEOUT_MS max wait for proxied MCP tools (default: 300000)
 *   OPENCODE_POLL_INTERVAL_MS session polling interval       (default: 2000)
 *   OPENCODE_INCLUDE_REASONING include reasoning parts        (default: off)
 *   OPENCODE_ALIAS_TOOLS     off|providers|models            (default: providers)
 *   DEBUG                     set "1" for verbose logs
 */

import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

// ─── Config ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_DEBUG = !!process.env.DEBUG;
const VERSION = "5.4.13";
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
function envMs(name, defaultValue, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) return defaultValue;
  return parsed;
}

const TOOL_TIMEOUT = envMs("OPENCODE_TOOL_TIMEOUT_MS", 0, { allowZero: true });
const RETURN_TIMEOUT = envMs("OPENCODE_MCP_RETURN_TIMEOUT_MS", 15_000, { allowZero: true });
const API_TIMEOUT = envMs("OPENCODE_API_TIMEOUT_MS", 10_000);
const MESSAGE_TIMEOUT = envMs("OPENCODE_MESSAGE_TIMEOUT_MS", 0, { allowZero: true });
const STATE_DIR = process.env.OPENCODE_MCP_STATE_DIR || join(homedir(), ".opencode-mcp", "state");
const STATE_FILE = join(STATE_DIR, "jobs.json");
const PRESERVE_JOBS = !["0", "false", "off", "no"].includes(normalizeName(process.env.OPENCODE_MCP_PRESERVE_JOBS || "1"));
const COMPLETED_JOB_TTL = envMs("OPENCODE_COMPLETED_JOB_TTL_MS", 600_000);
const STABLE_COMPLETION_MS = envMs("OPENCODE_STABLE_COMPLETION_MS", 30_000);
const PROGRESS_STALE_MS = parseInt(process.env.OPENCODE_PROGRESS_STALE_MS) || 120_000;
const STALE_TIMEOUT_MS = envMs("OPENCODE_STALE_TIMEOUT_MS", 0, { allowZero: true });
const PROXY_TIMEOUT = envMs("OPENCODE_PROXY_TIMEOUT_MS", 300_000);
const MODEL_CACHE_MS = envMs("OPENCODE_MODEL_CACHE_MS", 60_000);
const POLL_INTERVAL = envMs("OPENCODE_POLL_INTERVAL_MS", 2_000);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("Failed to reserve local port")));
    });
  });
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
    this._openServerPid = null;
    this._openServerStarting = null;
    this._openServerExitCode = null;
    this._modelCache = { at: 0, text: "", models: [] };
    this._modelAliasTools = [];
    this._modelToolBackend = {};
    this._modelToolCacheKey = "";
    this._emptyContextDir = null;
    this._jobs = new Map();
    this._completedJobs = new Map();

    // Proxied MCP backends
    this._mcpClients = []; // MCPClient[]
    this._proxiedTools = [];
    this._toolBackend = {}; // exposed tool name -> { clientName, originalName }
    this._hubReady = false;

    this._loadState();
  }

  // ── Backend: opencode serve ───────────────────────────────────────

  _serializeJob(job) {
    return {
      id: job.id,
      sid: job.sid,
      agent: job.agent,
      model: job.model,
      prompt: job.prompt,
      directory: job.directory,
      createdAt: job.createdAt,
      last: job.last || "",
      lastMessageCount: job.lastMessageCount || 0,
      submitDone: job.submitDone !== false,
      submitStartedAt: job.submitStartedAt || null,
      submitCompletedAt: job.submitCompletedAt || null,
      lastProgressAt: job.lastProgressAt || job.createdAt,
      progressSignature: job.progressSignature || "",
      pollCount: job.pollCount || 0,
      progress: job.progress || null,
    };
  }

  _restoreJob(saved) {
    if (!saved?.id || !saved?.sid) return null;
    return {
      id: saved.id,
      sid: saved.sid,
      agent: saved.agent || null,
      model: saved.model || null,
      prompt: saved.prompt || "",
      directory: saved.directory || process.cwd(),
      createdAt: saved.createdAt || Date.now(),
      last: saved.last || "",
      lastMessageCount: saved.lastMessageCount || 0,
      submitDone: true,
      submitError: null,
      submitStartedAt: saved.submitStartedAt || saved.createdAt || Date.now(),
      submitCompletedAt: saved.submitCompletedAt || null,
      lastProgressAt: saved.lastProgressAt || saved.createdAt || Date.now(),
      progressSignature: saved.progressSignature || "",
      pollCount: saved.pollCount || 0,
      progress: saved.progress || {
        phase: "waiting_for_messages",
        message_count: 0,
        assistant_count: 0,
        tool_part_count: 0,
        latest_assistant_index: -1,
        latest_assistant_complete: false,
        latest_assistant_tool_call_turn: false,
        latest_assistant_finish_reason: "",
        latest_assistant_text_chars: 0,
        last_poll_at: null,
        last_progress_at: saved.lastProgressAt || saved.createdAt || Date.now(),
        poll_count: saved.pollCount || 0,
      },
      restored: true,
    };
  }

  _loadState() {
    if (!PRESERVE_JOBS || !existsSync(STATE_FILE)) return;
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const state = JSON.parse(raw);
      if (state?.openServerUrl) this._openServerUrl = state.openServerUrl;
      if (state?.openServerPid) this._openServerPid = state.openServerPid;
      for (const saved of state?.jobs || []) {
        const job = this._restoreJob(saved);
        if (job) this._jobs.set(job.id, job);
      }
      const now = Date.now();
      for (const completed of state?.completedJobs || []) {
        if (!completed?.job_id || !completed?.text) continue;
        if (completed.completedAt && now - completed.completedAt > COMPLETED_JOB_TTL) continue;
        this._completedJobs.set(completed.job_id, completed);
      }
      this._pruneCompletedJobs({ save: false });
      log(`Restored ${this._jobs.size} active opencode job(s) from ${STATE_FILE}`);
    } catch (e) {
      log(`Could not load durable job state: ${e.message}`);
    }
  }

  _saveState() {
    if (!PRESERVE_JOBS) return;
    const jobs = [...this._jobs.values()].map(job => this._serializeJob(job));
    const completedJobs = [...this._completedJobs.values()];
    const openServerUrl = this._openServerUrl || null;
    const openServerPid = this._openServerPid || this._openServerProc?.pid || null;

    try {
      if (!jobs.length && !completedJobs.length && !openServerUrl) {
        if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
        return;
      }
      mkdirSync(STATE_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        version: VERSION,
        savedAt: Date.now(),
        openServerUrl,
        openServerPid,
        jobs,
        completedJobs,
      }, null, 2));
      renameSync(tmp, STATE_FILE);
    } catch (e) {
      log(`Could not save durable job state: ${e.message}`);
    }
  }

  _trackActiveJob(job) {
    this._jobs.set(job.id, job);
    this._saveState();
  }

  async _probeServer(url, timeoutMs = 1000) {
    if (!url) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(`${url}/__opencode_mcp_probe__`, {
        method: "GET",
        headers: { Authorization: AUTH },
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _waitForServer(url, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this._probeServer(url, 1000)) return;
      await sleep(100);
    }
    throw new Error("Opencode start timeout");
  }

  async _ensureOpencode() {
    if (this._openServerUrl) {
      if (this._openServerProc || await this._probeServer(this._openServerUrl)) return;
      log(`Persisted opencode server is not reachable: ${this._openServerUrl}`);
      this._openServerUrl = null;
      this._openServerPid = null;
      this._openServerExitCode = null;
      this._saveState();
    }
    if (this._openServerStarting) return this._openServerStarting;
    if (!OPENCODE_BIN) {
      throw new Error("opencode binary not found. Install it with: curl -fsSL https://opencode.ai/install | sh");
    }

    log("Starting opencode serve...");
    this._openServerStarting = (async () => {
      const port = await pickPort();
      const url = `http://127.0.0.1:${port}`;
      const proc = spawn(OPENCODE_BIN, ["serve", `--port=${port}`, "--hostname=127.0.0.1"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      proc.unref();
      this._openServerProc = proc;
      this._openServerPid = proc.pid || null;
      this._openServerUrl = url;
      this._openServerExitCode = null;
      this._saveState();

      proc.on("exit", (code) => {
        this._openServerExitCode = code;
        this._openServerProc = null;
        if (this._openServerPid === proc.pid) {
          this._openServerPid = null;
          this._openServerUrl = null;
          this._saveState();
        }
      });

      try {
        await this._waitForServer(url, 15000);
        log("Opencode ready:", this._openServerUrl);
      } catch (err) {
        try {
          if (proc.exitCode == null) proc.kill();
        } catch {}
        this._openServerProc = null;
        this._openServerPid = null;
        this._openServerUrl = null;
        this._saveState();
        throw err;
      } finally {
        this._openServerStarting = null;
      }
    })();
    return this._openServerStarting;
  }

  _stopOpencode() {
    if (this._openServerProc) {
      try { this._openServerProc.kill(); } catch {}
      this._openServerProc = null;
    } else if (this._openServerPid) {
      try { process.kill(this._openServerPid); } catch {}
    }
    this._openServerUrl = null;
    this._openServerPid = null;
    this._openServerExitCode = null;
    this._saveState();
  }

  async _api(method, path, body, queryParams, timeoutMs = API_TIMEOUT) {
    await this._ensureOpencode();
    let url = this._openServerUrl + path;
    if (queryParams) {
      const qs = new URLSearchParams(queryParams).toString();
      if (qs) url += "?" + qs;
    }
    const parsedTimeout = Number.parseInt(timeoutMs, 10);
    const requestTimeout = Number.isFinite(parsedTimeout) ? parsedTimeout : API_TIMEOUT;
    const controller = requestTimeout > 0 ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), requestTimeout) : null;
    try {
      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: AUTH },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller?.signal,
      });
      const text = await resp.text().catch(() => "");
      if (!resp.ok) throw new Error(`API ${resp.status}: ${text.slice(0, 500)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (e?.name === "AbortError") throw new Error(`API timeout after ${requestTimeout}ms: ${method} ${path}`);
      throw e;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  _apiErrorStatus(error) {
    const match = String(error?.message || "").match(/^API\s+(\d+):/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  _isApiStatus(error, statuses) {
    const status = this._apiErrorStatus(error);
    return Number.isFinite(status) && statuses.includes(status);
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
        background: { type: "boolean", description: "Start the opencode session and return a job_id immediately instead of waiting for completion." },
        wait_ms: { type: "integer", description: "Maximum synchronous wait before returning a pollable job. Clamped by OPENCODE_MCP_RETURN_TIMEOUT_MS." },
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

  _clampedWaitMs(waitMs) {
    if (waitMs === undefined || waitMs === null || waitMs === "") return RETURN_TIMEOUT;
    const parsed = Number.parseInt(waitMs, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return RETURN_TIMEOUT;
    return Math.min(parsed, RETURN_TIMEOUT);
  }

  _beginMessageSubmit(job, msgBody) {
    job.submitDone = false;
    job.submitError = null;
    job.submitStartedAt = Date.now();
    job.lastProgressAt = job.submitStartedAt;
    job.progressSignature = "";
    job.pollCount = 0;
    job.progress = {
      phase: "submitting",
      message_count: 0,
      assistant_count: 0,
      tool_part_count: 0,
      latest_assistant_index: -1,
      latest_assistant_complete: false,
      latest_assistant_tool_call_turn: false,
      latest_assistant_finish_reason: "",
      latest_assistant_text_chars: 0,
      latest_assistant_reasoning_chars: 0,
      last_poll_at: null,
      last_progress_at: job.lastProgressAt,
      poll_count: 0,
    };
    const submitAsync = () =>
      this._api(
        "POST",
        `/session/${job.sid}/prompt_async`,
        msgBody,
        { directory: job.directory },
        API_TIMEOUT,
      );
    const submitStreamingFallback = () =>
      this._api(
        "POST",
        `/session/${job.sid}/message`,
        msgBody,
        { directory: job.directory },
        MESSAGE_TIMEOUT,
      );
    job.submitPromise = submitAsync()
      .catch((error) => {
        if (this._isApiStatus(error, [404, 405])) {
          return submitStreamingFallback();
        }
        throw error;
      })
      .then((result) => {
        job.submitDone = true;
        job.submitCompletedAt = Date.now();
        this._updateJobProgress(job, {
          ...(job.progress || {}),
          phase: "submitted_waiting_for_messages",
        });
        job.submitResult = result;
        return result;
      })
      .catch((error) => {
        job.submitDone = true;
        job.submitCompletedAt = Date.now();
        job.submitError = error;
        this._updateJobProgress(job, {
          ...(job.progress || {}),
          phase: "submit_error",
        });
        log(`Message submit failed for session ${job.sid}: ${error.message}`);
        return null;
      });
  }

  _messageInfo(message) {
    return message?.info && typeof message.info === "object" ? message.info : message;
  }

  _isAssistantMessage(message) {
    return this._messageInfo(message)?.role === "assistant";
  }

  _isAssistantMessageComplete(message) {
    const completed = this._messageInfo(message)?.time?.completed;
    return typeof completed === "number" && Number.isFinite(completed);
  }

  _messageError(message) {
    const info = this._messageInfo(message) || {};
    return info.error || message?.error || message?.data?.error || null;
  }

  _messageFinishReason(message) {
    const info = this._messageInfo(message) || {};
    return info.finish || message?.finish || message?.data?.finish || "";
  }

  _hasToolCallParts(message) {
    return Array.isArray(message?.parts) && message.parts.some((part) => part?.type === "tool");
  }

  _isToolCallTurn(message) {
    return this._messageFinishReason(message) === "tool-calls" || this._hasToolCallParts(message);
  }

  _countParts(messages, type) {
    return messages.reduce((count, message) => {
      if (!Array.isArray(message?.parts)) return count;
      return count + message.parts.filter((part) => part?.type === type).length;
    }, 0);
  }

  _extractMessageText(message) {
    const parts = message?.parts;
    if (Array.isArray(parts)) {
      return parts
        .filter((part) => (part.type === "text" || (INCLUDE_REASONING && part.type === "reasoning")) && part.text)
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n");
    }
    return typeof message?.content === "string" ? message.content : "";
  }

  _reasoningTextChars(message) {
    const parts = message?.parts;
    if (!Array.isArray(parts)) return 0;
    return parts
      .filter((part) => part?.type === "reasoning" && part.text)
      .reduce((count, part) => count + String(part.text || "").length, 0);
  }

  _latestAssistantState(messages, prompt) {
    let latestAssistant = null;
    let latestAssistantIndex = -1;
    for (const [index, message] of messages.entries()) {
      if (this._isAssistantMessage(message)) {
        latestAssistant = message;
        latestAssistantIndex = index;
      }
    }

    if (!latestAssistant) {
      return {
        index: -1,
        text: "",
        complete: false,
        toolCallTurn: false,
        finishReason: "",
        toolPartCount: 0,
        reasoningChars: 0,
        hasLatestAssistant: false,
      };
    }

    const text = this._extractMessageText(latestAssistant);
    return {
      index: latestAssistantIndex,
      text: text && text !== prompt ? text : "",
      complete: this._isAssistantMessageComplete(latestAssistant),
      toolCallTurn: this._isToolCallTurn(latestAssistant),
      finishReason: this._messageFinishReason(latestAssistant),
      toolPartCount: this._countParts([latestAssistant], "tool"),
      reasoningChars: this._reasoningTextChars(latestAssistant),
      hasLatestAssistant: true,
    };
  }

  _progressPhase(job, latestAssistant, messageCount) {
    if (!job.submitDone && messageCount === 0) return "submitting";
    if (job.submitError && messageCount === 0) return "submit_error";
    if (messageCount === 0) return "waiting_for_messages";
    if (!latestAssistant.hasLatestAssistant) return "waiting_for_assistant";
    if (latestAssistant.toolCallTurn) {
      return latestAssistant.complete
        ? "tool_call_complete_waiting_for_followup"
        : "running_tools";
    }
    if (latestAssistant.text && latestAssistant.complete) return "final_text_complete";
    if (latestAssistant.text) return "receiving_text";
    if (latestAssistant.reasoningChars) return "receiving_reasoning";
    return "waiting_for_assistant_text";
  }

  _buildProgressSnapshot(job, messages, latestAssistant) {
    const assistantCount = messages.filter((message) => this._isAssistantMessage(message)).length;
    return {
      phase: this._progressPhase(job, latestAssistant, messages.length),
      message_count: messages.length,
      assistant_count: assistantCount,
      tool_part_count: this._countParts(messages, "tool"),
      latest_assistant_index: latestAssistant.index,
      latest_assistant_complete: !!latestAssistant.complete,
      latest_assistant_tool_call_turn: !!latestAssistant.toolCallTurn,
      latest_assistant_finish_reason: latestAssistant.finishReason || "",
      latest_assistant_text_chars: latestAssistant.text?.length || 0,
      latest_assistant_reasoning_chars: latestAssistant.reasoningChars || 0,
      last_poll_at: Date.now(),
      last_progress_at: job.lastProgressAt || job.createdAt || Date.now(),
      poll_count: job.pollCount || 0,
    };
  }

  _updateJobProgress(job, snapshot) {
    const now = Date.now();
    const signature = JSON.stringify([
      snapshot.phase,
      snapshot.message_count,
      snapshot.assistant_count,
      snapshot.tool_part_count,
      snapshot.latest_assistant_index,
      snapshot.latest_assistant_complete,
      snapshot.latest_assistant_tool_call_turn,
      snapshot.latest_assistant_finish_reason,
      snapshot.latest_assistant_text_chars,
      snapshot.latest_assistant_reasoning_chars,
    ]);
    if (signature !== job.progressSignature) {
      job.lastProgressAt = now;
      job.progressSignature = signature;
    }
    job.progress = {
      ...snapshot,
      last_poll_at: snapshot.last_poll_at || now,
      last_progress_at: job.lastProgressAt || now,
      poll_count: job.pollCount || 0,
    };
    return job.progress;
  }

  _jobProgressStats(job) {
    const progress = job.progress || {};
    const now = Date.now();
    const lastProgressAt = progress.last_progress_at || job.lastProgressAt || job.createdAt || now;
    const lastPollAt = progress.last_poll_at || null;
    return {
      progress,
      lastProgressAt,
      lastPollAt,
      lastActivityAge: Math.max(0, now - lastProgressAt),
      lastPollAge: lastPollAt ? Math.max(0, now - lastPollAt) : null,
    };
  }

  _isStaleTimedOut(job) {
    if (!STALE_TIMEOUT_MS) return false;
    const { lastActivityAge } = this._jobProgressStats(job);
    return lastActivityAge >= STALE_TIMEOUT_MS;
  }

  _formatProgressLines(job, result = {}) {
    const { progress, lastActivityAge, lastPollAge } = this._jobProgressStats(job);
    return [
      `elapsed_ms: ${Math.max(0, Math.round(result.elapsed || 0))}`,
      `phase: ${progress.phase || (job.submitDone ? "waiting_for_messages" : "submitting")}`,
      `last_progress_ms_ago: ${lastActivityAge}`,
      `last_poll_ms_ago: ${lastPollAge === null ? "never" : lastPollAge}`,
      `poll_count: ${progress.poll_count || job.pollCount || 0}`,
      `messages: ${progress.message_count || 0}`,
      `assistant_messages: ${progress.assistant_count || 0}`,
      `tool_parts: ${progress.tool_part_count || 0}`,
      `latest_assistant_index: ${progress.latest_assistant_index ?? -1}`,
      `latest_assistant_complete: ${!!progress.latest_assistant_complete}`,
      `latest_assistant_tool_call_turn: ${!!progress.latest_assistant_tool_call_turn}`,
      `latest_assistant_finish_reason: ${progress.latest_assistant_finish_reason || ""}`,
      `latest_assistant_text_chars: ${progress.latest_assistant_text_chars || 0}`,
      `latest_assistant_reasoning_chars: ${progress.latest_assistant_reasoning_chars || 0}`,
    ];
  }

  _formatProgressNotes(job) {
    const { progress, lastActivityAge } = this._jobProgressStats(job);
    const lines = [];
    if (job.lastPollError) {
      lines.push(`last_poll_error: ${job.lastPollError}`);
    }
    if (progress.phase === "tool_call_complete_waiting_for_followup") {
      lines.push("progress_note: latest assistant turn completed with tool calls; waiting for follow-up assistant text.");
    }
    if (progress.phase === "receiving_reasoning") {
      lines.push("progress_note: latest assistant is streaming reasoning; final visible text may arrive later.");
    }
    if (lastActivityAge >= PROGRESS_STALE_MS) {
      lines.push(`stale_warning: no session progress for ${lastActivityAge}ms`);
    }
    if (this._isStaleTimedOut(job)) {
      lines.push(`stale_timeout: no session progress for ${lastActivityAge}ms; threshold=${STALE_TIMEOUT_MS}ms`);
    }
    return lines;
  }

  _formatStaleJobTimeout(job, elapsed, last) {
    const lines = [
      "Opencode job marked stale and stopped.",
      `job_id: ${job.id}`,
      "status: stale_timeout",
      ...this._formatProgressLines(job, { elapsed }),
      ...this._formatProgressNotes(job),
    ];
    if (last) {
      lines.push("", "Latest partial output:", last.slice(0, 4000));
    }
    return lines.join("\n");
  }

  _formatMissingSessionJob(job, elapsed, last) {
    const lines = [
      "Opencode session is no longer available.",
      `job_id: ${job.id}`,
      "status: missing_session",
      ...this._formatProgressLines(job, { elapsed }),
      ...this._formatProgressNotes(job),
    ];
    if (last) {
      lines.push("", "Latest partial output:", last.slice(0, 4000));
    }
    return lines.join("\n");
  }

  async _completeStaleJob(job, sid, elapsed, last) {
    try { await this._api("DELETE", `/session/${sid}`); } catch {}
    const text = this._formatStaleJobTimeout(job, elapsed, last);
    const result = { status: "stale_timeout", elapsed, last, text };
    this._completeActiveJob(job, result);
    return result;
  }

  async _completeMissingSessionJob(job, elapsed, last, error) {
    job.lastPollError = error?.message || "session missing";
    job.lastPollErrorAt = Date.now();
    this._updateJobProgress(job, {
      ...(job.progress || {}),
      phase: "missing_session",
      last_poll_at: Date.now(),
    });
    const text = this._formatMissingSessionJob(job, elapsed, last);
    const result = { status: "missing_session", elapsed, last, text };
    this._completeActiveJob(job, result);
    return result;
  }

  _isTerminalJobResult(result) {
    return ["complete", "timeout", "stale_timeout", "missing_session"].includes(result?.status);
  }

  _pruneCompletedJobs({ save = true } = {}) {
    let changed = false;
    const now = Date.now();
    for (const [jobId, completed] of this._completedJobs.entries()) {
      if (now - completed.completedAt > COMPLETED_JOB_TTL) {
        this._completedJobs.delete(jobId);
        changed = true;
      }
    }
    if (changed && save) this._saveState();
  }

  _completeActiveJob(job, result) {
    const wasTracked = this._jobs.has(job.id);
    this._jobs.delete(job.id);
    if (wasTracked && result?.text) {
      this._completedJobs.set(job.id, {
        job_id: job.id,
        status: result.status || "complete",
        completedAt: Date.now(),
        text: result.text,
      });
      this._pruneCompletedJobs();
    }
    this._saveState();
  }

  async _createOpencodeJob(agent, model, prompt, directory, context = "cwd") {
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

    const job = {
      id: sid,
      sid,
      agent: agent || null,
      model: model || null,
      prompt,
      directory: dir,
      createdAt: Date.now(),
      last: "",
      lastMessageCount: 0,
    };
    this._beginMessageSubmit(job, msgBody);
    this._trackActiveJob(job);
    return job;
  }

  async _opencodeCall(agent, model, prompt, directory, context = "cwd", options = {}) {
    const callStart = Date.now();
    const waitBudget = this._clampedWaitMs(options.waitMs);
    const job = await this._createOpencodeJob(agent, model, prompt, directory, context);
    if (options.background) {
      this._trackActiveJob(job);
      return this._formatRunningJob(job, { elapsed: 0, last: "", reason: "background" });
    }

    const result = await this._pollSession(job, {
      maxWaitMs: Math.max(0, waitBudget - (Date.now() - callStart)),
      deleteOnComplete: true,
    });

    if (this._isTerminalJobResult(result)) {
      return result.text;
    }

    this._trackActiveJob(job);
    return this._formatRunningJob(job, result);
  }

  async _pollSession(job, options = {}) {
    const sid = job.sid || job.id;
    const prompt = job.prompt || "";
    const maxWaitMs = this._clampedWaitMs(options.maxWaitMs);
    const deleteOnComplete = options.deleteOnComplete !== false;
    const start = Date.now();
    const totalElapsed = () => Date.now() - (job.createdAt || start);
    let prev = job.lastMessageCount || 0;
    let stable = 0;
    let last = job.last || "";
    let completionSignalSeen = false;
    const remainingToolMs = () => TOOL_TIMEOUT > 0 ? TOOL_TIMEOUT - totalElapsed() : Number.POSITIVE_INFINITY;
    log(`Polling session ${sid} (max sync ${maxWaitMs}ms, max total ${TOOL_TIMEOUT}ms)...`);

    if (maxWaitMs <= 0) {
      return { status: "running", elapsed: totalElapsed(), last, reason: "no_wait" };
    }

    while (Date.now() - start < maxWaitMs && remainingToolMs() > 0) {
      if (job.submitError && !last) {
        try { await this._api("DELETE", `/session/${sid}`); } catch {}
        const result = {
          status: "timeout",
          elapsed: totalElapsed(),
          last,
          text: `Error submitting opencode message: ${job.submitError.message}`,
        };
        this._completeActiveJob(job, result);
        return result;
      }

      // Detect if opencode server process died
      if (this._openServerExitCode != null) {
        const msg = `Opencode server exited with code ${this._openServerExitCode}`;
        log(msg);
        try { await this._api("DELETE", `/session/${sid}`); } catch {}
        const result = { status: "timeout", elapsed: totalElapsed(), last, text: `Error: ${msg}` };
        this._completeActiveJob(job, result);
        return result;
      }

      const remainingBeforeSleep = Math.min(maxWaitMs - (Date.now() - start), remainingToolMs());
      if (remainingBeforeSleep <= 0) break;
      await new Promise(r => setTimeout(r, Math.min(POLL_INTERVAL, remainingBeforeSleep)));

      let msgs;
      try {
        const remainingForPoll = Math.min(maxWaitMs - (Date.now() - start), remainingToolMs());
        if (remainingForPoll <= 0) break;
        msgs = await this._api("GET", `/session/${sid}/message`, undefined, undefined, Math.min(API_TIMEOUT, remainingForPoll));
      } catch (e) {
        log(`Poll error: ${e.message}`);
        if (this._isApiStatus(e, [404, 410])) {
          return await this._completeMissingSessionJob(job, totalElapsed(), last, e);
        }
        job.lastPollError = e.message;
        job.lastPollErrorAt = Date.now();
        this._updateJobProgress(job, {
          ...(job.progress || {}),
          phase: "poll_error",
          last_poll_at: Date.now(),
        });
        continue; // transient, retry
      }

      if (!Array.isArray(msgs)) continue;
      job.pollCount = (job.pollCount || 0) + 1;
      job.lastPollError = null;

      // Check for assistant error on any message
      for (const m of msgs) {
        if (this._isAssistantMessage(m) && this._messageError(m)) {
          const err = this._messageError(m);
          const detail = err.data?.message || err.name || JSON.stringify(err);
          log(`Assistant error: ${detail}`);
          try { await this._api("DELETE", `/session/${sid}`); } catch {}
          const result = { status: "timeout", elapsed: totalElapsed(), last, text: `Error from model: ${detail}` };
          this._completeActiveJob(job, result);
          return result;
        }
      }

      const latestAssistant = this._latestAssistantState(msgs, prompt);
      this._updateJobProgress(job, this._buildProgressSnapshot(job, msgs, latestAssistant));
      let resp = latestAssistant.text;
      let assistantComplete = latestAssistant.complete && !!latestAssistant.text && !latestAssistant.toolCallTurn;
      if (!resp && !latestAssistant.hasLatestAssistant) {
        for (const m of msgs) {
          const t = this._extractMessageText(m);
          if (t && t !== prompt) {
            resp = t;
          }
        }
      }

      if (resp && resp !== last) {
        last = resp;
        stable = 0;
        job.last = last;
      }

      if (resp && assistantComplete) {
        completionSignalSeen = true;
        job.last = last;
        job.lastMessageCount = msgs.length;
        break;
      }

      if (this._isStaleTimedOut(job)) {
        return await this._completeStaleJob(job, sid, totalElapsed(), last);
      }

      // New messages arrived → reset stability
      if (msgs.length > prev) {
        prev = msgs.length;
        stable = 0;
        job.lastMessageCount = prev;
        continue;
      }

      // Same message count, content stabilized. This is only a legacy fallback
      // for opencode builds that do not expose assistant.time.completed.
      if (resp && resp === last && !latestAssistant.toolCallTurn) {
        stable++;
        if (stable >= 3 && totalElapsed() >= STABLE_COMPLETION_MS) {
          log(`Session ${sid} stabilized after ${Date.now() - start}ms`);
          job.last = last;
          job.lastMessageCount = msgs.length;
          break;
        }
      } else if (resp) {
        last = resp;
        stable = 0;
        job.last = last;
        job.lastMessageCount = msgs.length;
      }
    }

    const elapsed = totalElapsed();
    if (last && (completionSignalSeen || (stable >= 3 && elapsed >= STABLE_COMPLETION_MS))) {
      if (deleteOnComplete) {
        try { await this._api("DELETE", `/session/${sid}`); } catch {}
        this._completeActiveJob(job, { status: "complete", text: last });
      }
      log(`Session ${sid} complete: ${last.length} chars in ${elapsed}ms`);
      return { status: "complete", elapsed, last, text: last };
    }

    if (TOOL_TIMEOUT > 0 && elapsed >= TOOL_TIMEOUT) {
      try { await this._api("DELETE", `/session/${sid}`); } catch {}
      const text = last || `(no response after ${(elapsed / 1000).toFixed(0)}s)`;
      const result = { status: "timeout", elapsed, last, text: `Opencode job timed out after ${(elapsed / 1000).toFixed(0)}s.\n\n${text}` };
      this._completeActiveJob(job, result);
      return result;
    }

    if (this._isStaleTimedOut(job)) {
      return await this._completeStaleJob(job, sid, elapsed, last);
    }

    job.last = last;
    job.lastMessageCount = prev;
    return { status: "running", elapsed, last, reason: "return_timeout" };
  }

  _formatRunningJob(job, result = {}) {
    const suggestedWaitMs = RETURN_TIMEOUT > 0 ? Math.min(30_000, RETURN_TIMEOUT) : 0;
    const lines = [
      "Opencode job is still running.",
      `job_id: ${job.id}`,
      `status: running`,
      ...this._formatProgressLines(job, result),
      ...this._formatProgressNotes(job),
      "",
      "Poll with:",
      JSON.stringify({ tool: "opencode_job", arguments: { action: "status", job_id: job.id, wait_ms: suggestedWaitMs } }),
    ];
    if (!job.submitDone) {
      lines.splice(4, 0, "submit_status: pending");
    }
    if (result.last) {
      lines.push("", "Latest partial output:", result.last.slice(0, 4000));
    }
    return lines.join("\n");
  }

  _formatJobList() {
    this._pruneCompletedJobs();
    const jobs = [...this._jobs.values()].map((job) => ({
      ...(job.progress ? { progress: job.progress } : {}),
      job_id: job.id,
      agent: job.agent,
      model: job.model,
      age_ms: Date.now() - job.createdAt,
      has_partial: !!job.last,
      submit_pending: !job.submitDone,
      phase: job.progress?.phase || (job.submitDone ? "waiting_for_messages" : "submitting"),
      last_progress_ms_ago: Math.max(0, Date.now() - (job.progress?.last_progress_at || job.lastProgressAt || job.createdAt)),
      stale: Math.max(0, Date.now() - (job.progress?.last_progress_at || job.lastProgressAt || job.createdAt)) >= PROGRESS_STALE_MS,
      message_count: job.progress?.message_count || 0,
      assistant_count: job.progress?.assistant_count || 0,
      tool_part_count: job.progress?.tool_part_count || 0,
      latest_assistant_tool_call_turn: !!job.progress?.latest_assistant_tool_call_turn,
    }));
    const completed_jobs = [...this._completedJobs.values()].map((job) => ({
      job_id: job.job_id,
      status: job.status,
      age_ms: Date.now() - job.completedAt,
    }));
    return JSON.stringify({ jobs, completed_jobs }, null, 2);
  }

  async _jobToolCall(action, jobId, waitMs) {
    if (action === "list") return this._formatJobList();
    if (!jobId) return "Provide job_id for status or cancel.";
    this._pruneCompletedJobs();
    const job = this._jobs.get(jobId);
    if (!job) {
      const completed = this._completedJobs.get(jobId);
      if (completed) return completed.text;
      return `Job not found or already completed: ${jobId}`;
    }

    if (action === "cancel") {
      try { await this._api("DELETE", `/session/${job.sid}`); } catch {}
      this._jobs.delete(job.id);
      this._saveState();
      return `Cancelled opencode job: ${job.id}`;
    }

    if (action !== "status") return `Unknown job action: ${action}`;

    const result = await this._pollSession(job, {
      maxWaitMs: this._clampedWaitMs(waitMs ?? 30_000),
      deleteOnComplete: true,
    });

    if (this._isTerminalJobResult(result)) return result.text;
    this._trackActiveJob(job);
    return this._formatRunningJob(job, result);
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
          background: { type: "boolean", description: "Start the opencode session and return a job_id immediately instead of waiting for completion." },
          wait_ms: { type: "integer", description: "Maximum synchronous wait before returning a pollable job. Clamped by OPENCODE_MCP_RETURN_TIMEOUT_MS." },
        },
      },
    };
  }

  get _jobTool() {
    return {
      name: "opencode_job",
      description:
        "Poll, list, or cancel long-running opencode jobs returned by opencode/opencode_model_* tools.\n\n" +
        "Use this when a prior call returned a job_id because the model was still running.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["status", "cancel", "list"], description: "Job operation to perform." },
          job_id: { type: "string", description: "Job id returned by an earlier opencode call. Required for status/cancel." },
          wait_ms: { type: "integer", description: "Optional short wait while polling status. Clamped by OPENCODE_MCP_RETURN_TIMEOUT_MS." },
        },
      },
    };
  }

  get _allTools() {
    return [this._opencodeTool, this._jobTool, ...this._modelAliasTools, ...this._proxiedTools];
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
        const { model, prompt, list, directory, context, background, wait_ms } = args;
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
          const result = await this._opencodeCall(resolvedAgent.name, null, prompt, directory, context || "cwd", { background, waitMs: wait_ms });
          return this.r(id, { content: [{ type: "text", text: result }] });
        }
        if (model) {
          log(`Chat model: ${model}`);
          const result = await this._opencodeCall(null, model, prompt, directory, context || "cwd", { background, waitMs: wait_ms });
          return this.r(id, { content: [{ type: "text", text: result }] });
        }
        return this.toolError(id, "Provide agent+prompt, mode+prompt, model+prompt, or list.");
      }

      // ── Long-running opencode jobs ──────────────────────────────
      if (toolName === "opencode_job") {
        const { action, job_id, wait_ms } = args;
        const result = await this._jobToolCall(action, job_id, wait_ms);
        return this.r(id, { content: [{ type: "text", text: result }] });
      }

      // ── Dynamic opencode model alias tools ───────────────────────
      if (toolName.startsWith("opencode_model_") && !this._modelToolBackend[toolName]) {
        this._refreshModelAliasTools();
      }
      const modelBackend = this._modelToolBackend[toolName];
      if (modelBackend) {
        const { prompt, model, directory, context, background, wait_ms } = args;
        if (!prompt) return this.toolError(id, "Provide prompt.");
        const resolvedModel = this._resolveProviderModel(modelBackend, model);
        log(`Alias tool "${toolName}" resolved to model: ${resolvedModel}`);
        const result = await this._opencodeCall(null, resolvedModel, prompt, directory, context || "none", { background, waitMs: wait_ms });
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

  async _stopAll({ cancelJobs = false } = {}) {
    const preserveActiveJobs = PRESERVE_JOBS && !cancelJobs && this._jobs.size > 0;
    if (preserveActiveJobs) {
      log(`Preserving ${this._jobs.size} active opencode job(s) across bridge shutdown`);
      this._openServerProc = null;
      this._saveState();
    } else {
      this._stopOpencode();
    }

    for (const c of this._mcpClients) c.stop();
    this._mcpClients = [];
    this._proxiedTools = [];
    this._toolBackend = {};
    this._modelAliasTools = [];
    this._modelToolBackend = {};
    if (!preserveActiveJobs) {
      this._jobs.clear();
      this._completedJobs.clear();
      this._saveState();
    }
    this._mcpsStarted = null;
    if (this._emptyContextDir && !preserveActiveJobs) {
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

  _exit() { this._stopAll().finally(() => setTimeout(() => process.exit(0), 100)); }
}

// ─── Boot ──────────────────────────────────────────────────────────────────
const mcpList = CFG.mcp ? Object.keys(CFG.mcp).filter(k => CFG.mcp[k].enabled !== false) : [];
const skipSet = new Set((process.env.OPENCODE_MCP_SKIP || "").split(",").map(s => s.trim()).filter(Boolean));
const activeMcps = mcpList.filter(n => !skipSet.has(n));

console.error(`opencode-mcp v${VERSION} — MCP hub`);
console.error(`  opencode:      ${OPENCODE_BIN || "(not found; install opencode for model calls)"}`);
console.error(`  agents:        ${AGENTS.length} found`);
console.error(`  tool timeout:  ${TOOL_TIMEOUT > 0 ? `${(TOOL_TIMEOUT / 1000).toFixed(0)}s` : "disabled"}`);
console.error(`  proxy timeout: ${(PROXY_TIMEOUT / 1000).toFixed(0)}s`);
console.error(`  proxied MCPs:  ${activeMcps.length > 0 ? activeMcps.join(", ") : "(none)"}`);
console.error(`  debug:         ${IS_DEBUG ? "on" : "off (set DEBUG=1)"}`);
console.error(`Ready. Waiting for MCP messages on stdin...`);

const hub = new OpencodeHub();
hub.start();

// Clean shutdown on signals
function shutdownAndExit(code) {
  hub._stopAll().finally(() => process.exit(code));
}

process.on("SIGTERM", () => shutdownAndExit(0));
process.on("SIGINT", () => shutdownAndExit(0));
process.on("uncaughtException", (err) => {
  console.error("[obridge] Uncaught:", err.message);
  shutdownAndExit(1);
});
