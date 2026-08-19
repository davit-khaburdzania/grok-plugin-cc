import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/grok/scripts/lib/args.mjs";

test("parseArgs reads boolean flags and --flag=false", () => {
  const enabled = parseArgs(["--verbose"], { booleanOptions: ["verbose"] });
  assert.equal(enabled.options.verbose, true);
  assert.deepEqual(enabled.positionals, []);

  const disabled = parseArgs(["--verbose=false"], { booleanOptions: ["verbose"] });
  assert.equal(disabled.options.verbose, false);

  const truthy = parseArgs(["--verbose=anything"], { booleanOptions: ["verbose"] });
  assert.equal(truthy.options.verbose, true);
});

test("parseArgs reads --key value and --key=value", () => {
  const spaced = parseArgs(["--model", "grok-4.6"], { valueOptions: ["model"] });
  assert.equal(spaced.options.model, "grok-4.6");
  assert.deepEqual(spaced.positionals, []);

  const inline = parseArgs(["--model=grok-4.5"], { valueOptions: ["model"] });
  assert.equal(inline.options.model, "grok-4.5");
});

test("parseArgs resolves short aliases for value and boolean options", () => {
  const config = {
    valueOptions: ["model"],
    booleanOptions: ["force"],
    aliasMap: { m: "model", f: "force" }
  };
  const { options } = parseArgs(["-m", "grok-4.6", "-f"], config);
  assert.equal(options.model, "grok-4.6");
  assert.equal(options.force, true);
});

test("parseArgs resolves long aliases through aliasMap", () => {
  const { options } = parseArgs(["--base", "main"], {
    valueOptions: ["baseRef"],
    aliasMap: { base: "baseRef" }
  });
  assert.equal(options.baseRef, "main");
});

test("parseArgs collects repeatable options into an array", () => {
  const { options } = parseArgs(["--allow", "a", "--allow", "b", "--allow=c"], {
    repeatableOptions: ["allow"]
  });
  assert.deepEqual(options.allow, ["a", "b", "c"]);
});

test("parseArgs treats everything after -- as positionals", () => {
  const { options, positionals } = parseArgs(["--model", "x", "--", "--not-a-flag", "pos"], {
    valueOptions: ["model"]
  });
  assert.equal(options.model, "x");
  assert.deepEqual(positionals, ["--not-a-flag", "pos"]);
});

test("parseArgs keeps unknown dash tokens as positionals", () => {
  const { options, positionals } = parseArgs(["fix", "the", "--force", "handling"], {});
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["fix", "the", "--force", "handling"]);

  const single = parseArgs(["-"], {});
  assert.deepEqual(single.positionals, ["-"]);
});

test("parseArgs throws when a value option is missing its value", () => {
  assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value for --model/);
  assert.throws(
    () => parseArgs(["-m"], { valueOptions: ["model"], aliasMap: { m: "model" } }),
    /Missing value for -m/
  );
});

test("splitRawArgumentString honors single and double quotes", () => {
  assert.deepEqual(splitRawArgumentString("'hello world'"), ["hello world"]);
  assert.deepEqual(splitRawArgumentString('"a b" c'), ["a b", "c"]);
});

test("splitRawArgumentString honors escaped quotes and escaped spaces", () => {
  assert.deepEqual(splitRawArgumentString('a\\"b'), ['a"b']);
  assert.deepEqual(splitRawArgumentString("foo\\ bar"), ["foo bar"]);
  assert.deepEqual(splitRawArgumentString('"he said \\"hi\\""'), ['he said "hi"']);
});

test("splitRawArgumentString keeps a trailing backslash literal", () => {
  assert.deepEqual(splitRawArgumentString("abc\\"), ["abc\\"]);
});

test("splitRawArgumentString collapses runs of whitespace between tokens", () => {
  assert.deepEqual(splitRawArgumentString("a   b\t c"), ["a", "b", "c"]);
});

test("splitRawArgumentString returns no tokens for an empty string", () => {
  assert.deepEqual(splitRawArgumentString(""), []);
  assert.deepEqual(splitRawArgumentString("   "), []);
});
