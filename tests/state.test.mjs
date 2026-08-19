import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  getConfig,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  saveState,
  setConfig,
  upsertJob
} from "../plugins/grok/scripts/lib/state.mjs";

const DATA_DIR_ENV = "GROK_COMPANION_DATA_DIR";

// The state module reads process.env at call time, so set the data dir inside
// the test and restore the previous value afterwards.
function setDataDir(dir) {
  const previous = process.env[DATA_DIR_ENV];
  process.env[DATA_DIR_ENV] = dir;
  return () => {
    if (previous === undefined) {
      delete process.env[DATA_DIR_ENV];
    } else {
      process.env[DATA_DIR_ENV] = previous;
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("state dir respects GROK_COMPANION_DATA_DIR and differs per workspace", () => {
  const dataA = makeTempDir("grok-data-a-");
  const dataB = makeTempDir("grok-data-b-");
  const workspaceOne = makeTempDir("grok-ws-one-");
  const workspaceTwo = makeTempDir("grok-ws-two-");

  let restore = setDataDir(dataA);
  try {
    const dirA = resolveStateDir(workspaceOne);
    assert.ok(dirA.startsWith(path.join(dataA, "state")), dirA);

    // Same workspace, different data dir -> different state root.
    restore();
    restore = setDataDir(dataB);
    const dirB = resolveStateDir(workspaceOne);
    assert.ok(dirB.startsWith(path.join(dataB, "state")), dirB);
    assert.notEqual(dirA, dirB);

    // Same data dir, different workspace -> different state dir.
    const dirBOther = resolveStateDir(workspaceTwo);
    assert.notEqual(dirB, dirBOther);
    assert.ok(dirBOther.startsWith(path.join(dataB, "state")), dirBOther);
  } finally {
    restore();
  }
});

test("upsertJob inserts a new job then patches it with a refreshed updatedAt", async () => {
  const dataDir = makeTempDir("grok-data-upsert-");
  const cwd = makeTempDir("grok-ws-upsert-");
  const restore = setDataDir(dataDir);
  try {
    upsertJob(cwd, { id: "j1", status: "queued", title: "Investigate" });
    const [inserted] = listJobs(cwd);
    assert.equal(inserted.id, "j1");
    assert.equal(inserted.status, "queued");
    assert.equal(inserted.title, "Investigate");
    assert.equal(typeof inserted.createdAt, "string");
    assert.equal(inserted.createdAt, inserted.updatedAt);

    await sleep(10);
    upsertJob(cwd, { id: "j1", status: "running" });
    const jobs = listJobs(cwd);
    assert.equal(jobs.length, 1);
    const patched = jobs.find((job) => job.id === "j1");
    assert.equal(patched.status, "running");
    // Untouched fields survive the patch; createdAt is preserved.
    assert.equal(patched.title, "Investigate");
    assert.equal(patched.createdAt, inserted.createdAt);
    // updatedAt is refreshed on the patch.
    assert.notEqual(patched.updatedAt, patched.createdAt);
    assert.ok(patched.updatedAt > patched.createdAt, `${patched.updatedAt} > ${patched.createdAt}`);
  } finally {
    restore();
  }
});

test("setConfig and getConfig round-trip values", () => {
  const dataDir = makeTempDir("grok-data-config-");
  const cwd = makeTempDir("grok-ws-config-");
  const restore = setDataDir(dataDir);
  try {
    assert.equal(getConfig(cwd).stopReviewGate, false);
    setConfig(cwd, "stopReviewGate", true);
    assert.equal(getConfig(cwd).stopReviewGate, true);
    setConfig(cwd, "customKey", "hello");
    const config = getConfig(cwd);
    assert.equal(config.customKey, "hello");
    // Existing keys stay intact when another key is written.
    assert.equal(config.stopReviewGate, true);
  } finally {
    restore();
  }
});

test("saveState keeps the 50 newest jobs and deletes the files of pruned jobs", () => {
  const dataDir = makeTempDir("grok-data-prune-");
  const cwd = makeTempDir("grok-ws-prune-");
  const restore = setDataDir(dataDir);
  try {
    const oldId = "job-old";
    const oldJobFile = resolveJobFile(cwd, oldId);
    const oldLogFile = resolveJobLogFile(cwd, oldId);
    fs.writeFileSync(oldJobFile, JSON.stringify({ id: oldId }), "utf8");
    fs.writeFileSync(oldLogFile, "old log data\n", "utf8");

    // Persist the old job so it becomes part of the on-disk state.
    saveState(cwd, { jobs: [{ id: oldId, updatedAt: "2000-01-01T00:00:00.000Z", logFile: oldLogFile }] });
    assert.ok(fs.existsSync(oldJobFile), "old job file exists after first save");
    assert.ok(fs.existsSync(oldLogFile), "old log file exists after first save");
    assert.equal(listJobs(cwd).length, 1);

    // 50 newer jobs plus the old one -> 51 total, so the oldest is pruned.
    const newJobs = Array.from({ length: 50 }, (_, index) => ({
      id: `job-new-${index}`,
      updatedAt: `2024-01-01T00:00:${String(index).padStart(2, "0")}.000Z`
    }));
    const next = saveState(cwd, {
      jobs: [...newJobs, { id: oldId, updatedAt: "2000-01-01T00:00:00.000Z", logFile: oldLogFile }]
    });

    assert.equal(next.jobs.length, 50);
    assert.ok(!next.jobs.some((job) => job.id === oldId), "old job pruned out");
    assert.ok(next.jobs.some((job) => job.id === "job-new-49"), "newest jobs retained");

    // The pruned job's tracked files are removed.
    assert.ok(!fs.existsSync(oldJobFile), "old job file deleted");
    assert.ok(!fs.existsSync(oldLogFile), "old log file deleted");
  } finally {
    restore();
  }
});
