import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
const COMMANDS_DIR = path.join(PLUGIN_ROOT, "commands");

function readPluginFile(...segments) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, ...segments), "utf8");
}

function readCommand(name) {
  return fs.readFileSync(path.join(COMMANDS_DIR, name), "utf8");
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

test("the command directory holds exactly the expected command files", () => {
  const files = fs
    .readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();
  assert.deepEqual(files, [
    "adversarial-review.md",
    "cancel.md",
    "implement.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transcript.md",
    "transfer.md"
  ]);
});

test("every command file has frontmatter with a description", () => {
  for (const name of fs.readdirSync(COMMANDS_DIR).filter((file) => file.endsWith(".md"))) {
    const content = readCommand(name);
    assert.ok(content.startsWith("---"), `${name} starts with frontmatter`);
    const frontmatter = content.split("---")[1] ?? "";
    assert.match(frontmatter, /\ndescription:\s*\S/, `${name} declares a description`);
  }
});

test("review and adversarial-review commands stay review-only and call the companion", () => {
  const review = readCommand("review.md");
  const adversarial = readCommand("adversarial-review.md");
  for (const [label, content] of [["review", review], ["adversarial-review", adversarial]]) {
    assert.ok(content.includes("AskUserQuestion"), `${label} mentions AskUserQuestion`);
    assert.ok(content.includes("run_in_background: true"), `${label} mentions run_in_background: true`);
    assert.ok(content.includes("Do not fix issues"), `${label} forbids fixing issues`);
    assert.ok(content.includes("review-only"), `${label} is review-only`);
  }
  assert.ok(review.includes('grok-companion.mjs" review "$ARGUMENTS"'));
  assert.ok(adversarial.includes('grok-companion.mjs" adversarial-review "$ARGUMENTS"'));
});

test("rescue command routes to the grok-rescue subagent and resume helper", () => {
  const rescue = readCommand("rescue.md");
  assert.ok(rescue.includes("grok:grok-rescue"));
  assert.ok(rescue.includes("task-resume-candidate --json"));
  assert.ok(rescue.includes("Continue current Grok session"));
});

test("status/result/cancel/transcript/transfer use the inline node command form", () => {
  const inline = '!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs"';
  for (const name of ["status.md", "result.md", "cancel.md", "transcript.md", "transfer.md"]) {
    assert.ok(readCommand(name).includes(inline), `${name} uses the inline node form`);
  }
});

test("setup command offers the official install command", () => {
  const setup = readCommand("setup.md");
  assert.ok(setup.includes("curl -fsSL https://x.ai/cli/install.sh | bash"));
});

test("grok-rescue agent declares its name, tools, and skills", () => {
  const agent = readPluginFile("agents", "grok-rescue.md");
  assert.ok(agent.includes("name: grok-rescue"));
  assert.ok(agent.includes("tools: Bash"));
  assert.ok(agent.includes("grok-cli-runtime"));
  assert.ok(agent.includes("grok-prompting"));
});

test("hooks.json wires SessionStart, SessionEnd, and Stop to the plugin scripts", () => {
  const hooks = JSON.parse(readPluginFile("hooks", "hooks.json"));
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /session-lifecycle-hook\.mjs" SessionStart/);
  assert.match(hooks.hooks.SessionEnd[0].hooks[0].command, /session-lifecycle-hook\.mjs" SessionEnd/);
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /stop-review-gate-hook\.mjs/);
});

test("plugin.json and marketplace.json agree on name and version", () => {
  const plugin = JSON.parse(readPluginFile(".claude-plugin", "plugin.json"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(plugin.name, "grok");
  assert.equal(marketplace.name, "grok-build");
  assert.equal(marketplace.plugins[0].name, "grok");
  assert.equal(plugin.version, marketplace.metadata.version);
  assert.equal(plugin.version, marketplace.plugins[0].version);
});

test("no file under plugins/grok contains the em dash character (U+2014)", () => {
  const EM_DASH = "\u2014";
  const offenders = walkFiles(PLUGIN_ROOT).filter((file) => fs.readFileSync(file, "utf8").includes(EM_DASH));
  assert.deepEqual(offenders, [], `em dash found in: ${offenders.join(", ")}`);
});

test("no functional plugin file mentions codex or openai", () => {
  // NOTICE and LICENSE legitimately reference the upstream Codex plugin as
  // required by Apache-2.0 attribution; they are excluded on purpose. Every
  // other file (commands, agents, skills, prompts, scripts, config) must stay
  // free of codex/openai references.
  const LEGAL_ATTRIBUTION = new Set(["NOTICE", "LICENSE"]);
  const offenders = walkFiles(PLUGIN_ROOT)
    .filter((file) => !LEGAL_ATTRIBUTION.has(path.basename(file)))
    .filter((file) => /codex|openai/i.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], `codex/openai found in: ${offenders.join(", ")}`);
});

test("implement command runs the plan, launch, wait, verify loop with Grok as the worker", () => {
  const source = readCommand("implement.md");
  assert.match(source, /description: Claude plans, Grok implements/);
  assert.match(source, /Do not implement the change yourself/);
  assert.match(source, /grok-companion\.mjs" implement --background --title/);
  assert.match(source, /--verify "<verification command>"/);
  assert.match(source, /<<'PLAN'/);
  assert.match(source, /status <job-id> --wait --timeout-ms 540000/);
  assert.match(source, /timeout: 600000/);
  assert.match(source, /result <job-id>/);
  assert.match(source, /--resume-last/);
  assert.match(source, /--verify-only/);
  assert.match(source, /Run the plan's verification commands yourself/);
  assert.match(source, /at most two times per request/);
  assert.match(source, /Never fix Grok's code silently/);
  assert.match(source, /\/grok:setup/);
});
