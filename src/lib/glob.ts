// Mirrors mcs's Sources/mcs/Core/GlobMatcher.swift: POSIX fnmatch(3) with
// FNM_PATHNAME plus a `dir/` directory-suffix shortcut. Intentionally does NOT
// support `**` recursion — registry/CLI parity requires identical semantics.

export type Matcher = (path: string) => boolean;

export function compileMatcher(pattern: string): Matcher {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return () => false;

  if (trimmed.endsWith("/")) {
    const dirName = trimmed.slice(0, -1);
    if (dirName.length === 0) return () => false;
    const prefix = `${dirName}/`;
    return (path) => path === dirName || path.startsWith(prefix);
  }

  const re = compileFnmatch(trimmed);
  return (path) => re.test(path);
}

export function compileAnyMatcher(patterns: readonly string[]): Matcher {
  if (patterns.length === 0) return () => false;
  const matchers = patterns.map(compileMatcher);
  return (path) => matchers.some((m) => m(path));
}

export function globMatches(pattern: string, path: string): boolean {
  return compileMatcher(pattern)(path);
}

const REGEX_METACHARS = /[.+^$(){}|]/;

function compileFnmatch(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      // POSIX fnmatch default (no FNM_NOESCAPE): backslash escapes the next char to literal.
      const next = pattern[i + 1];
      out += REGEX_METACHARS.test(next) || next === "*" || next === "?" || next === "[" || next === "]" || next === "\\"
        ? `\\${next}`
        : next;
      i += 2;
    } else if (ch === "*") {
      out += "[^/]*";
      i++;
    } else if (ch === "?") {
      out += "[^/]";
      i++;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
        i++;
      } else {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += `[${cls}]`;
        i = close + 1;
      }
    } else if (REGEX_METACHARS.test(ch)) {
      out += `\\${ch}`;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  out += "$";
  try {
    return new RegExp(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid glob pattern '${pattern}': ${message}`);
  }
}
