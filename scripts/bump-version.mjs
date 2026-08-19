#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLUGIN_NAME = "grok";

function requireObject(value, label) {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} is missing or not an object.`);
  }
}

function findMarketplacePlugin(json) {
  const plugin = (json.plugins ?? []).find((entry) => entry?.name === PLUGIN_NAME);
  if (!plugin) {
    throw new Error(`.claude-plugin/marketplace.json has no plugin named "${PLUGIN_NAME}".`);
  }
  return plugin;
}

const TARGETS = [
  {
    file: "package.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  },
  {
    file: `plugins/${PLUGIN_NAME}/.claude-plugin/plugin.json`,
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  },
  {
    file: ".claude-plugin/marketplace.json",
    values: [
      {
        label: "metadata.version",
        get: (json) => json.metadata?.version,
        set: (json, version) => {
          requireObject(json.metadata, ".claude-plugin/marketplace.json metadata");
          json.metadata.version = version;
        }
      },
      {
        label: `plugins[${PLUGIN_NAME}].version`,
        get: (json) => findMarketplacePlugin(json).version,
        set: (json, version) => {
          findMarketplacePlugin(json).version = version;
        }
      }
    ]
  }
];

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <version>",
    "  node scripts/bump-version.mjs --check [version]",
    "",
    "Options:",
    "  --check       Verify manifest versions. Uses package.json when version is omitted.",
    "  --root <dir>  Run against a different repository root.",
    "  --help        Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    check: false,
    root: process.cwd(),
    version: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      const root = argv[index + 1];
      if (!root) {
        throw new Error("--root requires a directory.");
      }
      options.root = root;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    } else {
      options.version = arg;
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
}

export function checkVersions(root, expectedVersion = null) {
  const packageJson = readJson(path.join(root, "package.json"));
  const expected = expectedVersion ?? packageJson.version;
  validateVersion(expected);
  const mismatches = [];
  for (const target of TARGETS) {
    const filePath = path.join(root, target.file);
    const json = readJson(filePath);
    for (const value of target.values) {
      const actual = value.get(json);
      if (actual !== expected) {
        mismatches.push(`${target.file} ${value.label}: ${actual ?? "(missing)"} (expected ${expected})`);
      }
    }
  }
  return { expected, mismatches };
}

export function bumpVersions(root, version) {
  validateVersion(version);
  const updated = [];
  for (const target of TARGETS) {
    const filePath = path.join(root, target.file);
    const json = readJson(filePath);
    for (const value of target.values) {
      value.set(json, version);
    }
    writeJson(filePath, json);
    updated.push(target.file);
  }
  return updated;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.check) {
    const { expected, mismatches } = checkVersions(options.root, options.version);
    if (mismatches.length > 0) {
      console.error(`Version mismatch (expected ${expected}):`);
      for (const mismatch of mismatches) {
        console.error(`- ${mismatch}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`All manifests are at version ${expected}.`);
    return;
  }

  if (!options.version) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const updated = bumpVersions(options.root, options.version);
  for (const file of updated) {
    console.log(`Updated ${file} to ${options.version}.`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
