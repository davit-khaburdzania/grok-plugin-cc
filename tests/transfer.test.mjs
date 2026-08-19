import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  buildClaudeTranscriptDigest,
  resolveClaudeSessionPath
} from "../plugins/grok/scripts/lib/claude-session-transfer.mjs";

const ENTRIES = [
  { type: "user", message: { content: "First user message" }, sessionId: "claude-xyz", cwd: "/repo", gitBranch: "main" },
  {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Assistant reply one" },
        { type: "tool_use", name: "Read", input: { file_path: "/a.js" } }
      ]
    }
  },
  {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "secret reasoning here" },
        { type: "text", text: "After thinking" }
      ]
    }
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", content: [{ type: "text", text: "tool output text" }] }] }
  },
  { type: "assistant", message: { content: "Second assistant answer" } },
  { type: "user", message: { content: "sidechain message" }, isSidechain: true },
  { type: "assistant", message: { content: "meta message" }, isMeta: true }
];

function writeTranscript() {
  const projectsDir = makeTempDir("claude-projects-");
  const sourcePath = path.join(projectsDir, "session.jsonl");
  fs.writeFileSync(sourcePath, ENTRIES.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return { projectsDir, sourcePath };
}

test("resolveClaudeSessionPath accepts a file inside the projects dir override", () => {
  const { projectsDir, sourcePath } = writeTranscript();
  const resolved = resolveClaudeSessionPath(projectsDir, { source: sourcePath, projectsDir });
  assert.equal(resolved, fs.realpathSync(sourcePath));
});

test("resolveClaudeSessionPath rejects a file outside the projects dir", () => {
  const { projectsDir } = writeTranscript();
  const outsideDir = makeTempDir("outside-");
  const outsidePath = path.join(outsideDir, "other.jsonl");
  fs.writeFileSync(outsidePath, "{}\n", "utf8");
  assert.throws(
    () => resolveClaudeSessionPath(outsideDir, { source: outsidePath, projectsDir }),
    /can transfer Claude sessions only from/
  );
});

test("resolveClaudeSessionPath rejects a non-JSONL source", () => {
  const { projectsDir } = writeTranscript();
  const badPath = path.join(projectsDir, "notes.txt");
  fs.writeFileSync(badPath, "hi\n", "utf8");
  assert.throws(() => resolveClaudeSessionPath(projectsDir, { source: badPath, projectsDir }), /must be a JSONL file/);
});

test("buildClaudeTranscriptDigest turns a transcript into a Markdown digest", () => {
  const { sourcePath } = writeTranscript();
  const digest = buildClaudeTranscriptDigest(sourcePath);

  assert.equal(digest.claudeSessionId, "claude-xyz");
  assert.equal(digest.cwd, "/repo");
  assert.equal(digest.gitBranch, "main");
  assert.equal(digest.turnCount, 5);
  assert.equal(digest.truncatedTurns, 0);

  assert.match(digest.markdown, /## User/);
  assert.match(digest.markdown, /## Assistant/);
  assert.match(digest.markdown, /\[Tool call: Read\]/);
  assert.match(digest.markdown, /"file_path":"\/a\.js"/);
  assert.match(digest.markdown, /\[Tool result\] tool output text/);
  assert.match(digest.markdown, /After thinking/);
  assert.match(digest.markdown, /Second assistant answer/);

  // thinking blocks, sidechains, and meta entries are dropped.
  assert.doesNotMatch(digest.markdown, /secret reasoning/);
  assert.doesNotMatch(digest.markdown, /sidechain message/);
  assert.doesNotMatch(digest.markdown, /meta message/);

  // Consecutive same-role entries are merged: exactly two blocks per role.
  assert.equal(digest.markdown.match(/## Assistant/g).length, 2);
  assert.equal(digest.markdown.match(/## User/g).length, 2);
});

test("buildClaudeTranscriptDigest truncates to fit a tiny byte budget", () => {
  const { sourcePath } = writeTranscript();
  const digest = buildClaudeTranscriptDigest(sourcePath, { maxBytes: 60 });
  assert.ok(digest.truncatedTurns > 0, `truncatedTurns=${digest.truncatedTurns}`);
  assert.match(digest.markdown, /First user message/);
  assert.match(digest.markdown, /earlier turn\(s\) omitted/);
});
