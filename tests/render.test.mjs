import test from "node:test";
import assert from "node:assert/strict";

import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderTransferResult
} from "../plugins/grok/scripts/lib/render.mjs";

const REVIEW_META = { reviewLabel: "Review", targetLabel: "working tree diff", usageSummary: "1,050 tokens, 3 turns" };

test("renderReviewResult sorts findings by severity and formats file/line and confidence", () => {
  const parsed = {
    verdict: "needs-attention",
    summary: "Several issues.",
    findings: [
      { severity: "low", title: "Low one", file: "d.js", line_start: 1, confidence: 0.2 },
      { severity: "critical", title: "Crit one", file: "a.js", line_start: 5, line_end: 5, confidence: 0.5, recommendation: "Fix it." },
      { severity: "medium", title: "Med one", file: "c.js", line_start: 8 },
      { severity: "high", title: "High one", file: "b.js", line_start: 10, line_end: 20 }
    ],
    next_steps: ["Add a test."]
  };
  const output = renderReviewResult({ parsed, parseError: null, rawOutput: "{...}" }, REVIEW_META);

  assert.match(output, /# Grok Review/);
  assert.match(output, /Target: working tree diff/);
  assert.match(output, /Verdict: needs-attention/);

  const critIndex = output.indexOf("[critical]");
  const highIndex = output.indexOf("[high]");
  const medIndex = output.indexOf("[medium]");
  const lowIndex = output.indexOf("[low]");
  assert.ok(critIndex >= 0 && highIndex > critIndex && medIndex > highIndex && lowIndex > medIndex, output);

  // Single line -> (file:line); range -> (file:line-range).
  assert.match(output, /\[critical\] Crit one \(a\.js:5\) \(confidence 50%\)/);
  assert.match(output, /\[high\] High one \(b\.js:10-20\)/);
  assert.match(output, /Recommendation: Fix it\./);
  assert.match(output, /Next steps:\n- Add a test\./);
  assert.match(output, /Usage: 1,050 tokens, 3 turns/);
});

test("renderReviewResult reports a parse error and keeps the raw message", () => {
  const output = renderReviewResult(
    { parsed: null, parseError: "Unexpected token", rawOutput: "Looks fine to me." },
    REVIEW_META
  );
  assert.match(output, /Grok did not return valid structured JSON\./);
  assert.match(output, /Parse error: Unexpected token/);
  assert.match(output, /Looks fine to me\./);
});

test("renderReviewResult flags an unexpected review shape", () => {
  const output = renderReviewResult({ parsed: { hello: "world" }, parseError: null, rawOutput: '{"hello":"world"}' }, REVIEW_META);
  assert.match(output, /unexpected review shape/);
  assert.match(output, /Validation error: Missing string `verdict`\./);
});

test("renderTaskResult lists touched files and the usage summary", () => {
  const output = renderTaskResult(
    { rawOutput: "Fixed the bug." },
    { touchedFiles: ["src/a.js", "src/b.js"], usageSummary: "500 tokens, 2 turns" }
  );
  assert.match(output, /Fixed the bug\./);
  assert.match(output, /Touched files:\n- src\/a\.js\n- src\/b\.js/);
  assert.match(output, /Usage: 500 tokens, 2 turns/);
});

test("renderTaskResult falls back to the failure message when there is no output", () => {
  const output = renderTaskResult({ rawOutput: "", failureMessage: "Grok hit a rate limit." }, {});
  assert.match(output, /Grok hit a rate limit\./);
});

test("renderStatusReport shows running, latest finished, recent, and review-gate lines", () => {
  const report = {
    config: { stopReviewGate: true },
    running: [
      {
        id: "job-run",
        kindLabel: "rescue",
        status: "running",
        phase: "running",
        elapsed: "5s",
        grokSessionId: "sess-run",
        summary: "Working on it",
        logFile: "/tmp/job-run.log"
      }
    ],
    latestFinished: {
      id: "job-done",
      kindLabel: "review",
      status: "completed",
      jobClass: "review",
      title: "Latest review",
      summary: "All good",
      grokSessionId: "sess-done",
      duration: "12s",
      usage: { tokens: { total_tokens: 900 }, numTurns: 2, totalCostUsd: 0.01 }
    },
    recent: [
      {
        id: "job-old",
        kindLabel: "task",
        status: "failed",
        title: "Old task",
        summary: "Broke",
        duration: "3s"
      }
    ],
    needsReview: true
  };
  const output = renderStatusReport(report);
  assert.match(output, /# Grok Status/);
  assert.match(output, /Review gate: enabled/);
  assert.match(output, /Active jobs:/);
  assert.match(output, /job-run/);
  assert.match(output, /Latest finished:/);
  assert.match(output, /job-done/);
  assert.match(output, /Recent jobs:/);
  assert.match(output, /job-old/);
  assert.match(output, /stop-time review gate is enabled/);
});

test("renderJobStatusReport shows a cancel hint for a running job", () => {
  const output = renderJobStatusReport({
    id: "job-run",
    kindLabel: "rescue",
    status: "running",
    phase: "running",
    elapsed: "5s"
  });
  assert.match(output, /# Grok Job Status/);
  assert.match(output, /Cancel: \/grok:cancel job-run/);
});

test("renderJobStatusReport shows result and review hints for a finished write task", () => {
  const output = renderJobStatusReport({
    id: "job-task",
    kindLabel: "rescue",
    status: "completed",
    jobClass: "task",
    write: true,
    duration: "9s"
  });
  assert.match(output, /Result: \/grok:result job-task/);
  assert.match(output, /Review changes: \/grok:review --wait/);
  assert.match(output, /Stricter review: \/grok:adversarial-review --wait/);
});

test("renderStoredJobResult appends the Grok session id and resume command", () => {
  const output = renderStoredJobResult(
    { id: "job-x", title: "Task", status: "completed" },
    { rendered: "Grok did the work.\n", grokSessionId: "sess-42" }
  );
  assert.match(output, /Grok did the work\./);
  assert.match(output, /Grok session ID: sess-42/);
  assert.match(output, /Resume in Grok: grok --resume sess-42/);
});

test("renderCancelReport describes the cancelled job", () => {
  const output = renderCancelReport({ id: "job-c", title: "Long task", summary: "Was running", grokSessionId: "sess-c" });
  assert.match(output, /# Grok Cancel/);
  assert.match(output, /Cancelled job-c\./);
  assert.match(output, /- Title: Long task/);
  assert.match(output, /Grok session ID: sess-c \(partial work stays resumable with `grok --resume sess-c`\)/);
  assert.match(output, /Check `\/grok:status`/);
});

test("renderSetupReport lists models and next steps", () => {
  const output = renderSetupReport({
    ready: true,
    node: { detail: "node v22.23.1" },
    grok: { available: true, detail: "grok 1.0.5", binary: "/usr/bin/grok" },
    auth: {
      detail: "logged in with grok.com",
      models: [
        { id: "grok-4.6", isDefault: true },
        { id: "grok-4.5", isDefault: false }
      ]
    },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: ["Run /grok:review to try a review."]
  });
  assert.match(output, /# Grok Setup/);
  assert.match(output, /Status: ready/);
  assert.match(output, /- grok: grok 1\.0\.5 \(\/usr\/bin\/grok\)/);
  assert.match(output, /- models: grok-4\.6 \(default\), grok-4\.5/);
  assert.match(output, /Next steps:\n- Run \/grok:review to try a review\./);
});

test("renderTransferResult reports the session, source, summary, and usage", () => {
  const output = renderTransferResult({
    grokSessionId: "sess-t",
    resumeCommand: "grok --resume sess-t",
    sourcePath: "/repo/session.jsonl",
    turnCount: 3,
    truncatedTurns: 1,
    summary: "Handover summary.",
    usageSummary: "100 tokens"
  });
  assert.match(output, /Transferred the Claude Code session into a Grok session\./);
  assert.match(output, /Grok session ID: sess-t/);
  assert.match(output, /Resume in Grok: grok --resume sess-t/);
  assert.match(output, /Source: \/repo\/session\.jsonl \(3 turn\(s\), 1 earlier turn\(s\) omitted\)/);
  assert.match(output, /Handover summary\./);
  assert.match(output, /Usage: 100 tokens/);
});
