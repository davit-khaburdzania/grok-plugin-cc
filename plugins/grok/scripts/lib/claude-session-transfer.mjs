import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "GROK_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_MAX_DIGEST_BYTES = 160 * 1024;
const MAX_TOOL_INPUT_CHARS = 400;
const MAX_TOOL_RESULT_CHARS = 600;
const MAX_USER_TEXT_CHARS = 12_000;
const MAX_ASSISTANT_TEXT_CHARS = 12_000;

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

/**
 * Resolve the Claude transcript to transfer. The SessionStart hook exports the
 * current transcript path; `--source` is a manual override. Only files under
 * `~/.claude/projects` are accepted.
 */
export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(options.projectsDir ?? CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`The Grok plugin can transfer Claude sessions only from ${options.projectsDir ?? CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}

function truncate(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n... [truncated ${value.length - limit} characters]`;
}

function compactJson(value, limit) {
  let serialized;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return truncate(serialized ?? "", limit);
}

function extractText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (block?.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderUserEntry(entry) {
  const content = entry?.message?.content;
  const parts = [];
  if (typeof content === "string") {
    parts.push(truncate(content, MAX_USER_TEXT_CHARS));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(truncate(block.text, MAX_USER_TEXT_CHARS));
      } else if (block?.type === "tool_result") {
        const text = extractText(block.content);
        parts.push(`[Tool result] ${truncate(text.replace(/\s+/g, " ").trim(), MAX_TOOL_RESULT_CHARS) || "(no text)"}`);
      } else if (block?.type === "image") {
        parts.push("[Image attachment]");
      }
    }
  }
  const body = parts.filter(Boolean).join("\n\n").trim();
  return body ? { role: "user", body } : null;
}

function renderAssistantEntry(entry) {
  const content = entry?.message?.content;
  const parts = [];
  if (typeof content === "string") {
    parts.push(truncate(content, MAX_ASSISTANT_TEXT_CHARS));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(truncate(block.text, MAX_ASSISTANT_TEXT_CHARS));
      } else if (block?.type === "tool_use") {
        parts.push(`[Tool call: ${block.name ?? "tool"}] ${compactJson(block.input ?? {}, MAX_TOOL_INPUT_CHARS)}`);
      }
      // "thinking" blocks are intentionally skipped.
    }
  }
  const body = parts.filter(Boolean).join("\n\n").trim();
  return body ? { role: "assistant", body } : null;
}

function isSystemInjectedUserText(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed.startsWith("<system-reminder>") || trimmed.startsWith("<command-name>") || trimmed.startsWith("<local-command-stdout>");
}

/**
 * Convert a Claude Code transcript (JSONL) into a Markdown digest that fits
 * inside one Grok prompt. Keeps user and assistant turns, summarizes tool calls
 * and tool results, skips sidechains, meta entries, and reasoning blocks.
 */
export function buildClaudeTranscriptDigest(sourcePath, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_DIGEST_BYTES;
  const raw = fs.readFileSync(sourcePath, "utf8");
  const turns = [];
  let totalEntries = 0;
  let sessionId = null;
  let cwd = null;
  let gitBranch = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry?.isSidechain || entry?.isMeta) {
      continue;
    }
    sessionId = sessionId ?? entry?.sessionId ?? null;
    cwd = cwd ?? entry?.cwd ?? null;
    gitBranch = gitBranch ?? entry?.gitBranch ?? null;

    let rendered = null;
    if (entry?.type === "user") {
      rendered = renderUserEntry(entry);
      if (rendered && isSystemInjectedUserText(rendered.body)) {
        rendered = null;
      }
    } else if (entry?.type === "assistant") {
      rendered = renderAssistantEntry(entry);
    }
    if (!rendered) {
      continue;
    }
    totalEntries += 1;
    const previous = turns[turns.length - 1];
    if (previous && previous.role === rendered.role) {
      // Merge consecutive same-role entries (text + tool calls) into one block.
      previous.body = `${previous.body}\n\n${rendered.body}`;
    } else {
      turns.push(rendered);
    }
  }

  if (turns.length === 0) {
    throw new Error(`No user or assistant turns found in ${sourcePath}.`);
  }

  const renderTurn = (turn) => `## ${turn.role === "user" ? "User" : "Assistant"}\n\n${turn.body}\n`;
  const rendered = turns.map(renderTurn);
  const totalBytes = rendered.reduce((sum, block) => sum + Buffer.byteLength(block, "utf8"), 0);

  let body;
  let truncatedTurns = 0;
  if (totalBytes <= maxBytes) {
    body = rendered.join("\n");
  } else {
    // Keep the first user turn for intent, then as many of the latest turns as fit.
    const head = rendered[0];
    const headBytes = Buffer.byteLength(head, "utf8");
    const kept = [];
    let budget = maxBytes - headBytes - 200;
    for (let index = rendered.length - 1; index >= 1; index -= 1) {
      const block = rendered[index];
      const size = Buffer.byteLength(block, "utf8");
      if (size > budget) {
        break;
      }
      kept.unshift(block);
      budget -= size;
    }
    truncatedTurns = rendered.length - 1 - kept.length;
    body = [head, `_[${truncatedTurns} earlier turn(s) omitted to fit the transfer budget]_\n`, ...kept].join("\n");
  }

  return {
    sourcePath,
    claudeSessionId: sessionId,
    cwd,
    gitBranch,
    turnCount: totalEntries,
    truncatedTurns,
    markdown: body.trimEnd()
  };
}
