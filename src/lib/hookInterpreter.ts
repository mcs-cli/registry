// Mirrors mcs Sources/mcs/TechPack/HookInterpreter.swift — registry/CLI parity is the contract.

const DEFAULT_INTERPRETER = "bash";

const INFERENCE_TABLE: Record<string, string> = {
  sh: "bash",
  bash: "bash",
  zsh: "zsh",
  js: "node",
  mjs: "node",
  cjs: "node",
  py: "python3",
  rb: "ruby",
  pl: "perl",
};

const AMBIGUOUS_EXTENSIONS = new Set(["ts", "mts", "cts", "tsx"]);

const ASSUMED_PRESENT = new Set(["bash", "sh", "zsh"]);

const MAX_LENGTH = 200;

const BARE_NAME = "[A-Za-z0-9][A-Za-z0-9._+-]*";
const BARE_BINARY_REGEX = new RegExp(`^${BARE_NAME}$`);
const ABSOLUTE_BINARY_REGEX = new RegExp(`^(/${BARE_NAME})+$`);
const ARGUMENT_REGEX = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._+=-]*$/;

// Foundation's `.whitespacesAndNewlines`, which the Swift side trims with.
const EDGE_WHITESPACE_REGEX = /^[\p{Zs}\p{Zl}\p{Zp}\t\n\v\f\r\u0085]+|[\p{Zs}\p{Zl}\p{Zp}\t\n\v\f\r\u0085]+$/gu;
// Foundation's `.controlCharacters` (Cc + Cf) plus every whitespace scalar except plain space.
const FORBIDDEN_SCALAR_REGEX = /(?! )[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\u0085]/u;

const SEGMENTER = new Intl.Segmenter();

export function tokens(value: string): string[] {
  return value.split(/\p{White_Space}+/u).filter((t) => t.length > 0);
}

// Matches URL(fileURLWithPath:).lastPathComponent, which mcs uses for every basename.
export function lastPathComponent(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

// Matches URL.pathExtension: a leading dot (`.bashrc`) or a trailing one is not an extension.
function fileExtension(path: string): string {
  const name = lastPathComponent(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function inferred(path: string): string | null {
  const ext = fileExtension(path);
  if (!ext || AMBIGUOUS_EXTENSIONS.has(ext)) return null;
  return INFERENCE_TABLE[ext] ?? null;
}

export function resolveHookInterpreter(explicit: string | undefined, destination: string, source: string | undefined): string {
  if (explicit !== undefined) {
    const normalized = tokens(explicit).join(" ");
    if (normalized) return normalized;
  }
  const fromDestination = inferred(destination);
  if (fromDestination) return fromDestination;
  // An ambiguous or unknown destination extension is an answer in itself; only an absent one defers to the source.
  if (fileExtension(destination) === "" && source !== undefined) {
    const fromSource = inferred(source);
    if (fromSource) return fromSource;
  }
  return DEFAULT_INTERPRETER;
}

// Same destination-then-source precedence as resolveHookInterpreter, so the warning never contradicts resolution.
export function isAmbiguouslyTyped(destination: string, source: string | undefined): boolean {
  const ext = fileExtension(destination) || (source !== undefined ? fileExtension(source) : "");
  return AMBIGUOUS_EXTENSIONS.has(ext);
}

export function isCheckableBinary(binary: string): boolean {
  return !ASSUMED_PRESENT.has(binary);
}

// Looks through `env`: verifying `env` itself would pass while the hook dies for want of the real runtime.
export function interpreterBinary(interpreter: string): string {
  const parts = tokens(interpreter);
  const first = parts[0];
  if (first === undefined) return interpreter;
  if (lastPathComponent(first) !== "env") return first;

  let i = 1;
  while (i < parts.length) {
    const token = parts[i];
    if (token === "-u" || token === "--unset") {
      i += 2;
    } else if (token.startsWith("-") || token.includes("=")) {
      i += 1;
    } else {
      return token;
    }
  }
  return first;
}

export function hookInterpreterRejectionReason(interpreter: string): string | null {
  const trimmed = interpreter.replace(EDGE_WHITESPACE_REGEX, "");
  const offender = FORBIDDEN_SCALAR_REGEX.exec(trimmed);
  if (offender) {
    const hex = offender[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    return `hookInterpreter must not contain control characters or line breaks (found U+${hex})`;
  }
  // Swift's String.count counts grapheme clusters, never more than UTF-16 units — segment only when it could exceed.
  if (trimmed.length > MAX_LENGTH) {
    let length = 0;
    for (const _ of SEGMENTER.segment(trimmed)) length++;
    if (length > MAX_LENGTH) {
      return `hookInterpreter must be at most ${MAX_LENGTH} characters (got ${length})`;
    }
  }
  const parts = tokens(trimmed);
  const binary = parts[0];
  if (binary === undefined) {
    return "hookInterpreter must not be empty — omit it to use bash";
  }
  const validBinary = binary.startsWith("/") ? ABSOLUTE_BINARY_REGEX.test(binary) : BARE_BINARY_REGEX.test(binary);
  if (!validBinary) {
    return `hookInterpreter binary '${binary}' must be a bare command name or an absolute path, without shell metacharacters`;
  }
  for (const argument of parts.slice(1)) {
    if (!ARGUMENT_REGEX.test(argument)) {
      return `hookInterpreter argument '${argument}' must be a plain flag or word, without shell metacharacters — use a wrapper script for anything else`;
    }
  }
  return null;
}
