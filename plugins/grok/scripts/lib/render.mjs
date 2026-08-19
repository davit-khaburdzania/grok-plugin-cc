import { formatUsageSummary } from "./grok.mjs";

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

export function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    confidence: typeof source.confidence === "number" ? source.confidence : null,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps.filter((step) => typeof step === "string" && step.trim()).map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(result, "result") || Object.prototype.hasOwnProperty.call(result, "parseError");
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function formatGrokResumeCommand(sessionId) {
  if (!sessionId) {
    return null;
  }
  return `grok --resume ${sessionId}`;
}

function formatStoredUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return formatUsageSummary({
    usage: usage.tokens ?? usage.usage ?? usage,
    numTurns: usage.numTurns ?? null,
    totalCostUsd: usage.totalCostUsd ?? null
  });
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Grok Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/grok:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/grok:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.grokSessionId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  const usageLine = formatStoredUsage(job.usage);
  if (usageLine) {
    lines.push(`  Usage: ${usageLine}`);
  }
  if (job.grokSessionId) {
    lines.push(`  Grok session ID: ${job.grokSessionId}`);
    lines.push(`  Resume in Grok: ${formatGrokResumeCommand(job.grokSessionId)}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /grok:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /grok:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /grok:review --wait");
    lines.push("  Stricter review: /grok:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendUsageFooter(lines, usageSummary) {
  if (!usageSummary) {
    return;
  }
  lines.push("", `Usage: ${usageSummary}`);
}

export function renderSetupReport(report) {
  const lines = [
    "# Grok Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- grok: ${report.grok.available ? `${report.grok.detail} (${report.grok.binary})` : report.grok.detail}`,
    `- auth: ${report.auth.detail}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`
  ];

  if (report.auth.models?.length) {
    const modelList = report.auth.models.map((model) => (model.isDefault ? `${model.id} (default)` : model.id)).join(", ");
    lines.push(`- models: ${modelList}`);
  }
  lines.push("");

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  const header = [`# Grok ${meta.reviewLabel}`, "", `Target: ${meta.targetLabel}`];
  if (!parsedResult.parsed) {
    const lines = [...header, "", "Grok did not return valid structured JSON.", "", `- Parse error: ${parsedResult.parseError}`];
    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }
    appendUsageFooter(lines, meta.usageSummary);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [...header, "Grok returned JSON with an unexpected review shape.", "", `- Validation error: ${validationError}`];
    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }
    appendUsageFooter(lines, meta.usageSummary);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [...header, `Verdict: ${data.verdict}`, "", data.summary, ""];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      const confidence = finding.confidence == null ? "" : ` (confidence ${Math.round(finding.confidence * 100)}%)`;
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})${confidence}`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendUsageFooter(lines, meta.usageSummary);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(result, meta = {}) {
  const rawOutput = typeof result?.rawOutput === "string" ? result.rawOutput : "";
  const lines = [];
  if (rawOutput) {
    lines.push(rawOutput.trimEnd());
  } else {
    lines.push(String(result?.failureMessage ?? "").trim() || "Grok did not return a final message.");
  }
  if (meta.touchedFiles?.length) {
    lines.push("", "Touched files:");
    for (const file of meta.touchedFiles) {
      lines.push(`- ${file}`);
    }
  }
  appendUsageFooter(lines, meta.usageSummary);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStatusReport(report) {
  const lines = ["# Grok Status", "", `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`, ""];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending a turn triggers a Grok stop-gate review and blocks if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Grok Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function appendSessionFooter(output, sessionId) {
  const normalized = output.endsWith("\n") ? output : `${output}\n`;
  if (!sessionId) {
    return normalized;
  }
  return `${normalized}\nGrok session ID: ${sessionId}\nResume in Grok: ${formatGrokResumeCommand(sessionId)}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const sessionId = storedJob?.grokSessionId ?? job.grokSessionId ?? null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    return appendSessionFooter(storedJob.rendered, sessionId);
  }

  if (storedJob?.rendered) {
    return appendSessionFooter(storedJob.rendered, sessionId);
  }

  const rawOutput = typeof storedJob?.result?.rawOutput === "string" ? storedJob.result.rawOutput : "";
  if (rawOutput) {
    return appendSessionFooter(rawOutput, sessionId);
  }

  const lines = [`# ${job.title ?? "Grok Result"}`, "", `Job: ${job.id}`, `Status: ${job.status}`];

  if (sessionId) {
    lines.push(`Grok session ID: ${sessionId}`);
    lines.push(`Resume in Grok: ${formatGrokResumeCommand(sessionId)}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# Grok Cancel", "", `Cancelled ${job.id}.`, ""];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  if (job.grokSessionId) {
    lines.push(`- Grok session ID: ${job.grokSessionId} (partial work stays resumable with \`${formatGrokResumeCommand(job.grokSessionId)}\`)`);
  }
  lines.push("- Check `/grok:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude Code session into a Grok session.",
    `Grok session ID: ${payload.grokSessionId}`,
    `Resume in Grok: ${payload.resumeCommand}`,
    `Source: ${payload.sourcePath} (${payload.turnCount} turn(s)${payload.truncatedTurns ? `, ${payload.truncatedTurns} earlier turn(s) omitted` : ""})`
  ];
  if (payload.summary) {
    lines.push("", "Grok's summary of the transferred context:", "", payload.summary.trimEnd());
  }
  if (payload.usageSummary) {
    lines.push("", `Usage: ${payload.usageSummary}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
