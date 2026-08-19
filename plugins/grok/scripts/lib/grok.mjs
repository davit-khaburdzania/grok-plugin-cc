/**
 * Grok Build CLI runtime.
 *
 * Every Grok run is one headless `grok` subprocess:
 *   grok --prompt-file <file> --output-format streaming-json [--session-id <uuid> | --resume <id>] ...
 *
 * The NDJSON stream on stdout carries these event types (observed with grok 1.0.x):
 *   {"type":"text","data":"..."}                      assistant text delta
 *   {"type":"thought","data":"..."}                   reasoning delta
 *   {"type":"tool_call", toolCallId, title, kind, status, toolName, rawInput}
 *   {"type":"tool_call_update", toolCallId, status, content, rawOutput}
 *   {"type":"usage", usage}
 *   {"type":"available_commands", tools}
 *   {"type":"error","message":"..."}
 *   {"type":"end", stopReason, sessionId, requestId, usage, num_turns, total_cost_usd, modelUsage, structuredOutput?}
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, formatCommandFailure, runCommand, terminateProcessTree } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
export const VALID_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const BUILTIN_SANDBOX_PROFILES = ["off", "workspace", "read-only", "strict"];
export const READ_ONLY_REVIEW_TOOLS = ["read_file", "list_dir", "grep"];
export const GROK_BINARY_ENV = "GROK_PLUGIN_BIN";
export const GROK_HOME_ENV = "GROK_HOME";
export const INSTALL_COMMAND = "curl -fsSL https://x.ai/cli/install.sh | bash";
export const LOGIN_HINT = "Run `!grok login` (or `!grok login --device-code` without a browser, or export `XAI_API_KEY`).";

const MAX_REASONING_SECTIONS = 24;
const MAX_REASONING_SECTION_CHARS = 600;
const MAX_STDERR_LINES = 60;
const AUTH_PROBE_TIMEOUT_MS = 45_000;

let cachedBinary = null;

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    String(command ?? "")
  );
}

function resolveGrokHome(env = process.env) {
  return env[GROK_HOME_ENV] || path.join(os.homedir(), ".grok");
}

function candidateBinaries(env = process.env) {
  const candidates = [];
  if (env[GROK_BINARY_ENV]) {
    candidates.push(env[GROK_BINARY_ENV]);
  }
  candidates.push("grok");
  const home = resolveGrokHome(env);
  candidates.push(path.join(home, "bin", process.platform === "win32" ? "grok.exe" : "grok"));
  return candidates;
}

/**
 * Locate the `grok` executable: `$GROK_PLUGIN_BIN`, then `grok` on PATH, then
 * `$GROK_HOME/bin/grok` (default `~/.grok/bin/grok`).
 */
export function resolveGrokBinary(env = process.env, options = {}) {
  if (cachedBinary && !options.refresh) {
    return cachedBinary;
  }
  for (const candidate of candidateBinaries(env)) {
    const status = binaryAvailable(candidate, ["--version"], { env });
    if (status.available) {
      cachedBinary = candidate;
      return candidate;
    }
  }
  return env[GROK_BINARY_ENV] || "grok";
}

export function resetGrokBinaryCache() {
  cachedBinary = null;
}

export function getGrokAvailability(cwd, env = process.env) {
  const binary = resolveGrokBinary(env);
  const status = binaryAvailable(binary, ["--version"], { cwd, env });
  if (!status.available) {
    return {
      available: false,
      binary,
      version: null,
      detail: status.detail === "not found" ? `not found (install with \`${INSTALL_COMMAND}\`)` : status.detail
    };
  }
  const firstLine = status.detail.split(/\r?\n/)[0].trim();
  return {
    available: true,
    binary,
    version: firstLine.replace(/^grok\s+/i, "") || firstLine,
    detail: firstLine
  };
}

function parseModelsOutput(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const firstLine = lines.map((line) => line.trim()).find(Boolean) ?? "";
  const loggedInMatch = firstLine.match(/logged in(?: with (.+?))?\.?$/i);
  const notAuthenticated = /not authenticated|not signed in|not logged in/i.test(firstLine);
  const defaultModelMatch = String(stdout ?? "").match(/Default model:\s*(\S+)/i);
  const models = [];
  for (const line of lines) {
    const match = line.match(/^\s*[*-]\s+(\S+)(\s+\(default\))?\s*$/);
    if (match) {
      models.push({ id: match[1], isDefault: Boolean(match[2]) });
    }
  }
  return {
    loggedIn: Boolean(loggedInMatch) && !notAuthenticated,
    account: loggedInMatch?.[1]?.replace(/\.$/, "") ?? null,
    defaultModel: defaultModelMatch?.[1] ?? null,
    models,
    firstLine
  };
}

/**
 * Authentication probe. `grok models` prints "You are logged in with <account>."
 * or "You are not authenticated." followed by the model list, and exits 0 in
 * both cases.
 */
export function getGrokAuthStatus(cwd, env = process.env) {
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      account: null,
      defaultModel: null,
      models: [],
      apiKeyPresent: Boolean(env.XAI_API_KEY)
    };
  }

  const result = runCommand(availability.binary, ["models"], {
    cwd,
    env,
    timeout: AUTH_PROBE_TIMEOUT_MS
  });
  const apiKeyPresent = Boolean(env.XAI_API_KEY);

  if (result.error || result.status !== 0) {
    const detail = result.error
      ? result.error.code === "ETIMEDOUT"
        ? "`grok models` timed out"
        : result.error.message
      : formatCommandFailure(result);
    return {
      available: true,
      loggedIn: apiKeyPresent,
      detail: apiKeyPresent ? `API key present (XAI_API_KEY); \`grok models\` failed: ${detail}` : detail,
      account: apiKeyPresent ? "XAI_API_KEY" : null,
      defaultModel: null,
      models: [],
      apiKeyPresent
    };
  }

  const parsed = parseModelsOutput(result.stdout);
  const loggedIn = parsed.loggedIn || apiKeyPresent;
  const account = parsed.account ?? (apiKeyPresent ? "XAI_API_KEY" : null);
  let detail;
  if (parsed.loggedIn) {
    detail = `logged in${parsed.account ? ` with ${parsed.account}` : ""}`;
  } else if (apiKeyPresent) {
    detail = "API key present (XAI_API_KEY)";
  } else {
    detail = `not authenticated. ${LOGIN_HINT}`;
  }

  return {
    available: true,
    loggedIn,
    detail,
    account,
    defaultModel: parsed.defaultModel,
    models: parsed.models,
    apiKeyPresent
  };
}

export function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.includes(normalized)) {
    throw new Error(`Unsupported reasoning effort "${effort}". Use one of: ${VALID_REASONING_EFFORTS.join(", ")}.`);
  }
  return normalized;
}

export function normalizeSandboxProfile(profile, fallback) {
  if (profile == null || String(profile).trim() === "") {
    return fallback;
  }
  const normalized = String(profile).trim().toLowerCase();
  if (normalized === "none") {
    return "off";
  }
  return normalized;
}

export function createGrokSessionId() {
  return crypto.randomUUID();
}

function safeRealpath(value) {
  // Resolve symlinks for the longest existing ancestor, then re-append the rest
  // so paths of not-yet-created files still normalize (e.g. /var -> /private/var).
  let current = path.resolve(value);
  const remainder = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return remainder.length > 0 ? path.join(real, ...remainder.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(value);
      }
      remainder.push(path.basename(current));
      current = parent;
    }
  }
}

function displayPath(cwd, value) {
  const text = String(value ?? "");
  if (!text || !cwd || !path.isAbsolute(text)) {
    return text;
  }
  const candidates = [cwd, safeRealpath(cwd)];
  const targets = [text, safeRealpath(text)];
  for (const base of candidates) {
    for (const target of targets) {
      const relative = path.relative(base, target);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative;
      }
      if (relative === "") {
        return ".";
      }
    }
  }
  return text;
}

function describeToolCall(event, cwd = null) {
  const toolName = String(event.toolName ?? event.title ?? "tool");
  const kind = String(event.kind ?? "");
  const input = event.rawInput && typeof event.rawInput === "object" ? event.rawInput : {};

  if (kind === "execute" || toolName === "run_terminal_command") {
    const command = input.command ?? input.cmd ?? "";
    return {
      message: `Running command: ${shorten(command, 120) || toolName}`,
      phase: looksLikeVerificationCommand(command) ? "verifying" : "running"
    };
  }
  if (kind === "write" || toolName === "write") {
    return { message: `Writing ${shorten(displayPath(cwd, input.file_path ?? input.path ?? "file"), 120)}`, phase: "editing", touched: displayPath(cwd, input.file_path ?? input.path ?? null) || null };
  }
  if (kind === "edit" || toolName === "search_replace") {
    return { message: `Editing ${shorten(displayPath(cwd, input.file_path ?? input.path ?? "file"), 120)}`, phase: "editing", touched: displayPath(cwd, input.file_path ?? input.path ?? null) || null };
  }
  if (kind === "read" || toolName === "read_file") {
    return { message: `Reading ${shorten(displayPath(cwd, input.target_file ?? input.file_path ?? input.path ?? "file"), 120)}`, phase: "investigating" };
  }
  if (kind === "search" || toolName === "grep") {
    if (/web search/i.test(toolName) || input.variant === "WebSearch") {
      return { message: `Searching the web: ${shorten(input.query ?? "", 120)}`.trim(), phase: "investigating" };
    }
    return { message: `Searching: ${shorten(input.pattern ?? input.query ?? toolName, 120)}`, phase: "investigating" };
  }
  if (toolName === "list_dir") {
    return { message: `Listing ${shorten(displayPath(cwd, input.target_directory ?? input.path ?? "."), 120) || "."}`, phase: "investigating" };
  }
  if (toolName === "spawn_subagent") {
    return { message: `Starting subagent: ${shorten(input.description ?? input.task ?? input.prompt ?? "", 120) || "subagent"}`, phase: "investigating" };
  }
  if (toolName === "web_fetch") {
    return { message: `Fetching ${shorten(input.url ?? "", 120)}`, phase: "investigating" };
  }
  if (toolName === "todo_write") {
    return { message: "Updating plan.", phase: null };
  }
  return { message: `Running tool: ${shorten(toolName, 80)}`, phase: "investigating" };
}

function describeToolUpdate(event, pending) {
  const status = String(event.status ?? "");
  if (status !== "completed" && status !== "failed" && status !== "error") {
    return null;
  }
  const rawOutput = event.rawOutput && typeof event.rawOutput === "object" ? event.rawOutput : null;
  if (pending?.kind === "execute" && rawOutput && rawOutput.type === "Bash") {
    const exitCode = rawOutput.exit_code ?? "?";
    const command = rawOutput.command ?? pending.command ?? "";
    return {
      message: `Command ${status}: ${shorten(command, 120)} (exit ${exitCode})`,
      phase: looksLikeVerificationCommand(command) ? "verifying" : "running",
      exitCode,
      command
    };
  }
  if (pending?.kind === "write" || pending?.kind === "edit") {
    return { message: `File change ${status}: ${shorten(pending.touched ?? "", 120)}`.trim(), phase: "editing" };
  }
  if (status === "failed" || status === "error") {
    return { message: `Tool ${pending?.toolName ?? "call"} ${status}.`, phase: null };
  }
  return null;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || (!message && Object.keys(extra).length === 0)) {
    return;
  }
  onProgress({ message: message ?? "", phase, ...extra });
}

function trimStderr(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return lines.slice(-MAX_STDERR_LINES).join("\n");
}

function createTurnState(options) {
  return {
    cwd: options.cwd ?? null,
    textSegments: [],
    currentText: "",
    currentThought: "",
    reasoningSummary: [],
    toolCalls: new Map(),
    touchedFiles: new Set(),
    commandExecutions: [],
    structuredOutput: null,
    stopReason: null,
    grokSessionId: options.resumeSessionId ?? options.sessionId ?? null,
    usage: null,
    numTurns: null,
    totalCostUsd: null,
    modelUsage: null,
    endSeen: false,
    errorMessage: null,
    onProgress: options.onProgress ?? null,
    logFullOutput: options.logFullOutput !== false
  };
}

function flushThought(state) {
  const thought = state.currentThought.trim();
  state.currentThought = "";
  if (!thought) {
    return;
  }
  if (state.reasoningSummary.length < MAX_REASONING_SECTIONS) {
    state.reasoningSummary.push(shorten(thought, MAX_REASONING_SECTION_CHARS));
  }
  emitProgress(state.onProgress, "", null, {
    logTitle: "Reasoning",
    logBody: thought.length > 4000 ? `${thought.slice(0, 4000)}...` : thought
  });
}

function flushText(state) {
  const text = state.currentText.trim();
  state.currentText = "";
  if (!text) {
    return;
  }
  state.textSegments.push(text);
  emitProgress(state.onProgress, "", null, {
    logTitle: "Assistant message",
    logBody: text
  });
}

function applyEvent(state, event) {
  const type = String(event?.type ?? "");
  switch (type) {
    case "text":
      if (state.currentThought) {
        flushThought(state);
      }
      state.currentText += String(event.data ?? "");
      return;
    case "thought":
      state.currentThought += String(event.data ?? "");
      return;
    case "tool_call": {
      flushThought(state);
      flushText(state);
      const described = describeToolCall(event, state.cwd);
      const input = event.rawInput && typeof event.rawInput === "object" ? event.rawInput : {};
      state.toolCalls.set(event.toolCallId, {
        kind: event.kind ?? null,
        toolName: event.toolName ?? event.title ?? null,
        command: input.command ?? null,
        touched: described.touched ?? null
      });
      if (described.touched) {
        state.touchedFiles.add(described.touched);
      }
      emitProgress(state.onProgress, described.message, described.phase);
      return;
    }
    case "tool_call_update": {
      const pending = state.toolCalls.get(event.toolCallId) ?? null;
      const described = describeToolUpdate(event, pending);
      if (described?.command !== undefined) {
        state.commandExecutions.push({ command: described.command, exitCode: described.exitCode });
      }
      if (described) {
        emitProgress(state.onProgress, described.message, described.phase);
      }
      return;
    }
    case "error":
      flushThought(state);
      flushText(state);
      state.errorMessage = String(event.message ?? "Grok reported an error.");
      emitProgress(state.onProgress, `Grok error: ${shorten(state.errorMessage, 200)}`, "failed");
      return;
    case "end":
      flushThought(state);
      flushText(state);
      state.endSeen = true;
      state.stopReason = event.stopReason ?? null;
      state.grokSessionId = event.sessionId ?? state.grokSessionId;
      state.usage = event.usage ?? null;
      state.numTurns = event.num_turns ?? null;
      state.totalCostUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
      state.modelUsage = event.modelUsage ?? null;
      if (Object.prototype.hasOwnProperty.call(event, "structuredOutput")) {
        state.structuredOutput = event.structuredOutput;
      }
      emitProgress(state.onProgress, `Turn completed (${state.stopReason ?? "unknown"}).`, "finalizing", {
        grokSessionId: state.grokSessionId
      });
      return;
    case "usage":
    case "available_commands":
    default:
      return;
  }
}

function buildArgs(options) {
  const args = ["--prompt-file", options.promptFile, "--output-format", "streaming-json"];

  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--reasoning-effort", options.effort);
  }
  if (options.sandbox && options.sandbox !== "off") {
    args.push("--sandbox", options.sandbox);
  }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }
  if (Array.isArray(options.disallowedTools) && options.disallowedTools.length > 0) {
    args.push("--disallowed-tools", options.disallowedTools.join(","));
  }
  if (options.alwaysApprove !== false) {
    args.push("--always-approve");
  }
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  if (Number.isFinite(options.maxTurns) && options.maxTurns > 0) {
    args.push("--max-turns", String(Math.floor(options.maxTurns)));
  }
  if (options.noPlan !== false) {
    args.push("--no-plan");
  }
  if (options.disableWebSearch) {
    args.push("--disable-web-search");
  }
  for (const rule of options.allowRules ?? []) {
    args.push("--allow", rule);
  }
  for (const rule of options.denyRules ?? []) {
    args.push("--deny", rule);
  }
  if (Array.isArray(options.extraArgs)) {
    args.push(...options.extraArgs);
  }
  return args;
}

function resolvePromptFile(options) {
  if (options.promptFile) {
    fs.mkdirSync(path.dirname(options.promptFile), { recursive: true });
    fs.writeFileSync(options.promptFile, options.prompt, "utf8");
    return { promptFile: options.promptFile, cleanup: () => {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-prompt-"));
  const promptFile = path.join(dir, "prompt.md");
  fs.writeFileSync(promptFile, options.prompt, "utf8");
  return {
    promptFile,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };
}

/**
 * Run one Grok turn and capture the result.
 *
 * @param {string} cwd
 * @param {{
 *   prompt: string,
 *   resumeSessionId?: string | null,
 *   sessionId?: string | null,
 *   model?: string | null,
 *   effort?: string | null,
 *   sandbox?: string | null,
 *   tools?: string[] | null,
 *   disallowedTools?: string[] | null,
 *   alwaysApprove?: boolean,
 *   jsonSchema?: object | null,
 *   maxTurns?: number | null,
 *   noPlan?: boolean,
 *   disableWebSearch?: boolean,
 *   allowRules?: string[],
 *   denyRules?: string[],
 *   extraArgs?: string[],
 *   promptFile?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   onProgress?: ((event: object) => void) | null,
 *   onSpawn?: ((info: { pid: number, grokSessionId: string | null }) => void) | null
 * }} options
 */
export async function runGrokTurn(cwd, options = {}) {
  const env = options.env ?? process.env;
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    throw new Error(`Grok CLI is not installed. Install it with \`${INSTALL_COMMAND}\`, then rerun \`/grok:setup\`.`);
  }

  const prompt = String(options.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("A prompt is required for this Grok run.");
  }

  const sessionId = options.resumeSessionId ? null : options.sessionId ?? createGrokSessionId();
  const { promptFile, cleanup } = resolvePromptFile({ ...options, prompt });
  const args = buildArgs({ ...options, promptFile, sessionId });
  const state = createTurnState({ ...options, sessionId, cwd });

  emitProgress(
    state.onProgress,
    options.resumeSessionId ? `Resuming Grok session ${options.resumeSessionId}.` : `Starting Grok session ${sessionId}.`,
    "starting",
    { grokSessionId: state.grokSessionId }
  );

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(availability.binary, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }

    let settled = false;
    let stderrBuffer = "";
    let spawnError = null;
    const signalHandlers = new Map();

    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      signalHandlers.clear();
    };

    const forwardTermination = (signal) => {
      try {
        terminateProcessTree(child.pid, { signal: "SIGTERM" });
      } catch {
        // ignore
      }
      removeSignalHandlers();
      // Re-raise so the parent exits with the conventional signal status.
      setTimeout(() => {
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exit(1);
        }
      }, 50).unref();
    };

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => forwardTermination(signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    const finish = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalHandlers();
      cleanup();
      fn();
    };

    child.on("error", (error) => {
      spawnError = error;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      if (stderrBuffer.length > 200_000) {
        stderrBuffer = stderrBuffer.slice(-100_000);
      }
    });

    emitProgress(state.onProgress, `Grok process started (pid ${child.pid}).`, "starting", {
      grokPid: child.pid,
      grokSessionId: state.grokSessionId
    });
    options.onSpawn?.({ pid: child.pid, grokSessionId: state.grokSessionId });

    const lineReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lineReader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // In streaming-json mode every model message arrives as an event, so a
        // bare stdout line is a CLI notice (for example "Session ... found locally").
        emitProgress(state.onProgress, `Grok: ${shorten(trimmed, 160)}`);
        return;
      }
      try {
        applyEvent(state, event);
      } catch (error) {
        emitProgress(state.onProgress, `Event handling error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    let exitInfo = null;
    let stdoutClosed = false;

    const maybeResolve = () => {
      if (!exitInfo || !stdoutClosed) {
        return;
      }
      finish(() => {
        flushThought(state);
        flushText(state);
        const stderr = trimStderr(stderrBuffer);
        const { code, signal } = exitInfo;

        if (spawnError) {
          reject(spawnError.code === "ENOENT" ? new Error(`Grok CLI is not installed (${availability.binary} not found). Install it with \`${INSTALL_COMMAND}\`.`) : spawnError);
          return;
        }

        let errorMessage = state.errorMessage;
        let status = 0;
        if (signal) {
          status = 1;
          errorMessage = errorMessage ?? `Grok was terminated (${signal}).`;
        } else if (code !== 0) {
          status = 1;
          errorMessage = errorMessage ?? (stderr ? stderr.split("\n").slice(-3).join("\n") : `Grok exited with code ${code}.`);
        } else if (!state.endSeen) {
          status = 1;
          errorMessage = errorMessage ?? "Grok exited without a final result event.";
        } else if (state.stopReason === "cancelled") {
          status = 1;
          errorMessage =
            errorMessage ??
            "Grok stopped before finishing (stopReason: cancelled). A tool call was probably denied by a permission rule; check the job log.";
        } else if (state.errorMessage) {
          status = 1;
        }

        const finalMessage = state.textSegments.join("\n\n").trim();
        resolve({
          status,
          exitCode: code,
          signal,
          grokSessionId: state.grokSessionId,
          grokPid: child.pid,
          finalMessage,
          textSegments: state.textSegments,
          structuredOutput: state.structuredOutput,
          stopReason: state.stopReason,
          usage: state.usage,
          numTurns: state.numTurns,
          totalCostUsd: state.totalCostUsd,
          modelUsage: state.modelUsage,
          reasoningSummary: state.reasoningSummary,
          touchedFiles: [...state.touchedFiles].sort(),
          commandExecutions: state.commandExecutions,
          stderr,
          error: errorMessage ? { message: errorMessage } : null,
          args
        });
      });
    };

    lineReader.on("close", () => {
      stdoutClosed = true;
      maybeResolve();
    });

    child.on("close", (code, signal) => {
      exitInfo = { code, signal };
      maybeResolve();
    });
  });
}

export function interruptGrokRun(pid) {
  return terminateProcessTree(pid);
}

export function exportGrokSession(cwd, sessionId, env = process.env) {
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    throw new Error(`Grok CLI is not installed. Install it with \`${INSTALL_COMMAND}\`.`);
  }
  const result = runCommand(availability.binary, ["export", sessionId], { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result.stdout;
}

export function formatUsageSummary(result) {
  if (!result) {
    return null;
  }
  const usage = result.usage ?? null;
  const parts = [];
  if (usage && Number.isFinite(usage.total_tokens)) {
    parts.push(`${usage.total_tokens.toLocaleString("en-US")} tokens`);
  } else if (usage && (Number.isFinite(usage.input_tokens) || Number.isFinite(usage.output_tokens))) {
    parts.push(`${(usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)} tokens`);
  }
  if (Number.isFinite(result.numTurns)) {
    parts.push(`${result.numTurns} turn${result.numTurns === 1 ? "" : "s"}`);
  }
  if (Number.isFinite(result.totalCostUsd)) {
    parts.push(`$${result.totalCostUsd.toFixed(4)}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function findBalancedObjectEnd(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Extract the last JSON object from free-form assistant text. Prefers the last
 * ```json fenced block; falls back to the last balanced top-level `{...}`.
 */
export function extractJsonObject(text) {
  const source = String(text ?? "");
  const fenceMatches = [...source.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)\n\s*```/g)];
  for (let index = fenceMatches.length - 1; index >= 0; index -= 1) {
    const candidate = fenceMatches[index][1].trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      return { parsed: JSON.parse(candidate), raw: candidate, parseError: null };
    } catch (error) {
      return { parsed: null, raw: candidate, parseError: error.message };
    }
  }

  // Fall back to the last balanced top-level object (string-aware forward scan).
  let best = null;
  let bestEnd = -1;
  for (let start = source.indexOf("{"); start !== -1; start = source.indexOf("{", start + 1)) {
    const endIndex = findBalancedObjectEnd(source, start);
    if (endIndex === -1 || endIndex < bestEnd) {
      continue;
    }
    const candidate = source.slice(start, endIndex + 1);
    try {
      const parsed = JSON.parse(candidate);
      // Prefer the object that ends last; on equal end keep the outermost (earlier start).
      if (endIndex > bestEnd) {
        best = { parsed, raw: candidate, parseError: null };
        bestEnd = endIndex;
      }
    } catch {
      // keep scanning
    }
  }
  if (best) {
    return best;
  }

  return { parsed: null, raw: source.trim(), parseError: source.trim() ? "No JSON object found in the final message." : null };
}

export function parseStructuredOutput(result, fallback = {}) {
  if (result?.structuredOutput && typeof result.structuredOutput === "object") {
    return {
      parsed: result.structuredOutput,
      parseError: null,
      rawOutput: JSON.stringify(result.structuredOutput),
      ...fallback
    };
  }

  const segments = Array.isArray(result?.textSegments) ? result.textSegments : [];
  const finalText = segments.length > 0 ? segments[segments.length - 1] : String(result?.finalMessage ?? "");
  if (!finalText.trim()) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: "",
      ...fallback
    };
  }

  const extracted = extractJsonObject(finalText);
  if (!extracted.parsed && segments.length > 1) {
    // The JSON may have been split across the last two segments; try the whole message.
    const whole = extractJsonObject(String(result?.finalMessage ?? ""));
    if (whole.parsed) {
      return { parsed: whole.parsed, parseError: null, rawOutput: whole.raw, ...fallback };
    }
  }
  return {
    parsed: extracted.parsed,
    parseError: extracted.parsed ? null : extracted.parseError ?? "Grok did not return valid JSON.",
    rawOutput: extracted.parsed ? extracted.raw : finalText,
    ...fallback
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}
