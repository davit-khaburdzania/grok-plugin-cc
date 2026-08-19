import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  createGrokSessionId,
  extractJsonObject,
  formatUsageSummary,
  getGrokAuthStatus,
  getGrokAvailability,
  normalizeReasoningEffort,
  normalizeSandboxProfile,
  parseStructuredOutput,
  READ_ONLY_REVIEW_TOOLS,
  resetGrokBinaryCache,
  VALID_REASONING_EFFORTS
} from "../plugins/grok/scripts/lib/grok.mjs";

test("extractJsonObject prefers the last fenced JSON block", () => {
  const text = "intro\n```json\n{\"a\":1}\n```\nmiddle\n```json\n{\"a\":2}\n```\n";
  const result = extractJsonObject(text);
  assert.deepEqual(result.parsed, { a: 2 });
  assert.equal(result.parseError, null);
});

test("extractJsonObject falls back to the last balanced top-level object", () => {
  const result = extractJsonObject('note {"x":1} and later {"y":2} done');
  assert.deepEqual(result.parsed, { y: 2 });
});

test("extractJsonObject ignores braces inside strings", () => {
  const result = extractJsonObject('{"msg":"open { and close }"}');
  assert.deepEqual(result.parsed, { msg: "open { and close }" });
});

test("extractJsonObject reports a parse error for invalid JSON in a fence", () => {
  const result = extractJsonObject("```json\n{not valid}\n```");
  assert.equal(result.parsed, null);
  assert.equal(result.raw, "{not valid}");
  assert.ok(result.parseError, "parseError is set");
});

test("extractJsonObject reports no JSON found, and a clean null for empty input", () => {
  const none = extractJsonObject("just some prose, no braces");
  assert.equal(none.parsed, null);
  assert.match(none.parseError, /No JSON object found/);

  const empty = extractJsonObject("");
  assert.equal(empty.parsed, null);
  assert.equal(empty.parseError, null);
});

test("parseStructuredOutput prefers structuredOutput", () => {
  const result = parseStructuredOutput({ structuredOutput: { verdict: "approve" } });
  assert.deepEqual(result.parsed, { verdict: "approve" });
  assert.equal(result.parseError, null);
});

test("parseStructuredOutput reads the last text segment when there is no structuredOutput", () => {
  const result = parseStructuredOutput({ textSegments: ["preamble", "```json\n{\"b\":2}\n```"] });
  assert.deepEqual(result.parsed, { b: 2 });
});

test("parseStructuredOutput falls back to the whole message across segments", () => {
  const result = parseStructuredOutput({
    textSegments: ["alpha", "beta"],
    finalMessage: 'recap {"d":4} end'
  });
  assert.deepEqual(result.parsed, { d: 4 });
});

test("parseStructuredOutput reports a parse error for an empty final message", () => {
  const result = parseStructuredOutput({ textSegments: [], finalMessage: "" });
  assert.equal(result.parsed, null);
  assert.ok(result.parseError);
});

test("normalizeReasoningEffort accepts valid values and rejects unknown ones", () => {
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
  assert.equal(normalizeReasoningEffort(null), null);
  assert.equal(normalizeReasoningEffort(""), null);
  assert.throws(() => normalizeReasoningEffort("turbo"), /Unsupported reasoning effort "turbo"/);
});

test("normalizeSandboxProfile maps none to off and falls back", () => {
  assert.equal(normalizeSandboxProfile("none", "workspace"), "off");
  assert.equal(normalizeSandboxProfile(null, "read-only"), "read-only");
  assert.equal(normalizeSandboxProfile("", "read-only"), "read-only");
  assert.equal(normalizeSandboxProfile("Workspace"), "workspace");
  assert.equal(normalizeSandboxProfile("read-only", "off"), "read-only");
});

test("formatUsageSummary handles token, turn, and cost combinations", () => {
  assert.equal(formatUsageSummary(null), null);
  assert.equal(
    formatUsageSummary({ usage: { total_tokens: 1050 }, numTurns: 2, totalCostUsd: 0.02 }),
    "1,050 tokens, 2 turns, $0.0200"
  );
  assert.equal(formatUsageSummary({ usage: { input_tokens: 1000, output_tokens: 50 } }), "1050 tokens");
  assert.equal(formatUsageSummary({ numTurns: 1 }), "1 turn");
  assert.equal(formatUsageSummary({}), null);
});

test("constant tables and session ids match the runtime contract", () => {
  assert.deepEqual(VALID_REASONING_EFFORTS, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(READ_ONLY_REVIEW_TOOLS, ["read_file", "list_dir", "grep"]);

  const first = createGrokSessionId();
  const second = createGrokSessionId();
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("getGrokAvailability and getGrokAuthStatus report a logged-in fake grok", () => {
  const binDir = makeTempDir("grok-fake-bin-");
  installFakeGrok(binDir);
  const cwd = makeTempDir("grok-cwd-");
  resetGrokBinaryCache();
  const env = buildEnv(binDir);

  const availability = getGrokAvailability(cwd, env);
  assert.equal(availability.available, true);
  assert.match(availability.version, /1\.0\.5/);

  const auth = getGrokAuthStatus(cwd, env);
  assert.equal(auth.available, true);
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.account, "grok.com");
  assert.equal(auth.defaultModel, "grok-4.6");
  assert.deepEqual(auth.models.map((model) => model.id), ["grok-4.6", "grok-4.5"]);
  assert.equal(auth.apiKeyPresent, false);
});

test("getGrokAuthStatus reports a not-authenticated fake grok", () => {
  const binDir = makeTempDir("grok-fake-bin-");
  installFakeGrok(binDir);
  const cwd = makeTempDir("grok-cwd-");
  resetGrokBinaryCache();
  const env = buildEnv(binDir, { FAKE_GROK_AUTH: "not-authenticated" });

  const auth = getGrokAuthStatus(cwd, env);
  assert.equal(auth.available, true);
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.account, null);
  assert.equal(auth.apiKeyPresent, false);
  assert.match(auth.detail, /not authenticated/i);
});

test("getGrokAuthStatus treats XAI_API_KEY as authentication", () => {
  const binDir = makeTempDir("grok-fake-bin-");
  installFakeGrok(binDir);
  const cwd = makeTempDir("grok-cwd-");
  resetGrokBinaryCache();
  const env = buildEnv(binDir, { FAKE_GROK_AUTH: "not-authenticated", XAI_API_KEY: "xai-test" });

  const auth = getGrokAuthStatus(cwd, env);
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.account, "XAI_API_KEY");
  assert.equal(auth.apiKeyPresent, true);
  assert.match(auth.detail, /API key present/i);
});
