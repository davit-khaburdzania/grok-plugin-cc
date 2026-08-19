/**
 * Minimal argv parser used by the companion script.
 *
 * Supports:
 * - `--flag` / `--flag=false` for boolean options
 * - `--key value` / `--key=value` for value options
 * - `-k value` / `-f` short aliases through `aliasMap`
 * - `--` passthrough: every later token is positional
 * Unknown dash tokens are treated as positionals so that free-form prompt
 * text such as "fix the --force handling" survives intact.
 */
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const repeatableOptions = new Set(config.repeatableOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  const assignValue = (key, value) => {
    if (repeatableOptions.has(key)) {
      options[key] = [...(options[key] ?? []), value];
      return;
    }
    options[key] = value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key) || repeatableOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        assignValue(key, nextValue);
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key) || repeatableOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      assignValue(key, nextValue);
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

/**
 * Split a raw slash-command argument string into shell-like tokens.
 * Honors single quotes, double quotes, and backslash escapes.
 */
export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let tokenStarted = false;

  for (const character of String(raw ?? "")) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += character;
    tokenStarted = true;
  }

  if (escaping) {
    current += "\\";
    tokenStarted = true;
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}
