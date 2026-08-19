import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { commitAll, initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget
} from "../plugins/grok/scripts/lib/git.mjs";

function baseRepo() {
  const repo = makeTempDir("grok-git-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n", "utf8");
  commitAll(repo, "init");
  return repo;
}

test("ensureGitRepository throws outside a repository and returns the toplevel inside one", () => {
  const plain = makeTempDir("grok-plain-");
  assert.throws(() => ensureGitRepository(plain), /must run inside a Git repository/);

  const repo = baseRepo();
  const top = ensureGitRepository(repo);
  assert.equal(typeof top, "string");
  assert.ok(top.endsWith(path.basename(repo)), top);
});

test("resolveReviewTarget auto selects the working tree when it is dirty", () => {
  const repo = baseRepo();
  fs.writeFileSync(path.join(repo, "new.txt"), "hi\n", "utf8");
  const target = resolveReviewTarget(repo, {});
  assert.equal(target.mode, "working-tree");
  assert.equal(target.label, "working tree diff");
  assert.equal(target.explicit, false);
});

test("resolveReviewTarget auto selects a branch diff against main when clean", () => {
  const repo = baseRepo();
  run("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
  commitAll(repo, "feature work");

  const target = resolveReviewTarget(repo, {});
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.equal(target.label, "branch diff against main");
  assert.equal(target.explicit, false);
});

test("resolveReviewTarget honors an explicit --base ref", () => {
  const repo = baseRepo();
  const target = resolveReviewTarget(repo, { base: "main" });
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.equal(target.label, "branch diff against main");
  assert.equal(target.explicit, true);
});

test("resolveReviewTarget scope=working-tree is explicit", () => {
  const repo = baseRepo();
  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  assert.equal(target.mode, "working-tree");
  assert.equal(target.explicit, true);
});

test("resolveReviewTarget throws on an unsupported scope", () => {
  const repo = baseRepo();
  assert.throws(() => resolveReviewTarget(repo, { scope: "staged" }), /Unsupported review scope/);
});

test("collectReviewContext inlines one small changed file", () => {
  const repo = baseRepo();
  fs.writeFileSync(path.join(repo, "calc.js"), "const a = 1;\n", "utf8");
  commitAll(repo, "add calc");
  fs.writeFileSync(path.join(repo, "calc.js"), "const a = 2;\n", "utf8");

  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  const context = collectReviewContext(repo, target);
  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.fullContent, /## Git Status/);
  assert.match(context.fullContent, /@@/);
  assert.match(context.fullContent, /const a = 2;/);
});

test("collectReviewContext hands more than two changed files over as a context file", () => {
  const repo = baseRepo();
  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(path.join(repo, `file-${index}.txt`), `content ${index}\n`, "utf8");
  }
  commitAll(repo, "add files");
  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(path.join(repo, `file-${index}.txt`), `changed ${index}\n`, "utf8");
  }

  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  const context = collectReviewContext(repo, target);
  assert.equal(context.inputMode, "context-file");
  assert.ok(context.fileCount > 2, `fileCount=${context.fileCount}`);
  assert.match(context.overview, /## Changed Files/);
  assert.match(context.fullContent, /@@/);
  assert.match(context.fullContent, /changed 1/);
});

test("collectReviewContext skips an untracked binary file", () => {
  const repo = baseRepo();
  fs.writeFileSync(path.join(repo, "blob.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  const context = collectReviewContext(repo, target);
  assert.match(context.fullContent, /skipped: binary file/);
});

test("collectReviewContext skips an untracked file over the 24KB limit with a message", () => {
  const repo = baseRepo();
  fs.writeFileSync(path.join(repo, "big.txt"), "a".repeat(25 * 1024), "utf8");
  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  const context = collectReviewContext(repo, target);
  assert.match(context.fullContent, /exceeds 24576 byte limit/);
});

test("collectReviewContext for a branch diff includes commit log and branch diff", () => {
  const repo = baseRepo();
  run("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature body\n", "utf8");
  commitAll(repo, "feature commit");

  const target = resolveReviewTarget(repo, { base: "main" });
  const context = collectReviewContext(repo, target);
  assert.equal(context.mode, "branch");
  assert.match(context.fullContent, /## Commit Log/);
  assert.match(context.fullContent, /## Branch Diff/);
  assert.match(context.fullContent, /feature body/);
});
