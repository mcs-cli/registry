/**
 * Synthetic tests for techpack.yaml validation, runHeuristics, and ignore-field
 * parity with mcs pack validate. Run: `npx tsx scripts/test-validator.ts`
 *
 * Pairs with scripts/test-validation.ts (live-pack smoke). This file uses
 * synthesized inputs to exercise paths the live smoke can't reach: malformed
 * patterns, the unreferenced-hint cap, the load-bearing-file safety rule, and
 * built-in-set drift against mcs.
 */
import { validateTechpackYaml, runHeuristics } from "../src/lib/validator.js";
import { BUILTIN_IGNORED_DIRS, BUILTIN_INFRASTRUCTURE_FILES } from "../src/lib/builtinIgnore.js";
import type { RepoTree } from "../src/types.js";

let pass = 0;
let fail = 0;

function eq<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log("  ok  ", label);
  } else {
    fail++;
    console.log("  FAIL", label);
    console.log("        expected:", expected);
    console.log("        actual:  ", actual);
  }
}

function baseManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    identifier: "test",
    displayName: "Test",
    description: "test pack",
    components: [{ id: "c1", description: "x", hook: { source: "hooks/handler.sh" } }],
    ...extra,
  };
}

function tree(files: string[], dirs: string[] = []): RepoTree {
  return { files: new Set(files), directories: new Set(dirs) };
}

const yamlOf = (m: Record<string, unknown>) => JSON.stringify(m); // js-yaml accepts JSON

console.log("=== validateTechpackYaml: ignore field ===");

{
  const r = validateTechpackYaml(yamlOf(baseManifest({ ignore: ["*.yaml"] })));
  eq("rejects ignore matching techpack.yaml", r.valid, false);
  eq("error mentions techpack.yaml", r.errors.some((e) => e.includes("techpack.yaml")), true);
}
{
  const r = validateTechpackYaml(yamlOf(baseManifest({ ignore: ["hooks/"] })));
  eq("rejects ignore matching referenced path", r.valid, false);
  eq("error mentions referenced path", r.errors.some((e) => e.includes("referenced path")), true);
}
{
  const r = validateTechpackYaml(yamlOf(baseManifest({ ignore: ["docs/"] })));
  eq("accepts safe ignore entry", r.valid, true);
}
{
  const r = validateTechpackYaml(yamlOf(baseManifest({ ignore: [""] })));
  eq("rejects empty ignore entry", r.valid, false);
}
{
  const r = validateTechpackYaml(yamlOf(baseManifest({ ignore: "docs/" })));
  eq("rejects non-array ignore", r.valid, false);
}
{
  const r = validateTechpackYaml(yamlOf(baseManifest()));
  eq("baseline no ignore valid", r.valid, true);
}

console.log("\n=== runHeuristics ===");

{
  const m = baseManifest({ ignore: ["docs/"] });
  const t = tree(["hooks/handler.sh", "docs/foo.md", "docs/sub/x.md"], ["hooks", "docs", "docs/sub"]);
  eq("ignore dir/ silences subtree", runHeuristics(m, t).filter((h) => h.includes("docs")), []);
}
{
  const m = baseManifest({ ignore: ["docs/*"] });
  const t = tree(["hooks/handler.sh", "docs/foo.md", "docs/sub/x.md"], ["hooks", "docs", "docs/sub"]);
  const hints = runHeuristics(m, t);
  eq("docs/* silences direct child", hints.some((h) => h.includes("docs/foo.md")), false);
  eq("docs/* does NOT silence nested (FNM_PATHNAME)", hints.some((h) => h.includes("docs/sub/x.md")), true);
}
{
  const m = baseManifest();
  const t = tree(["hooks/handler.sh", "node_modules/lib/x.js"], ["hooks", "node_modules", "node_modules/lib"]);
  eq("node_modules suppressed by built-in", runHeuristics(m, t).some((h) => h.includes("node_modules")), false);
}
{
  const m = baseManifest();
  const t = tree(["hooks/handler.sh", "README.md"], ["hooks"]);
  eq("README.md no warning", runHeuristics(m, t).some((h) => h.includes("README.md")), false);
}
{
  const m = baseManifest();
  const t = tree(["hooks/handler.sh", "extras.txt"], ["hooks"]);
  eq(
    "extras.txt root-level warning",
    runHeuristics(m, t).some((h) => h.includes("extras.txt") && h.includes("repository root")),
    true
  );
}
{
  const m = baseManifest({ ignore: ["extras.txt"] });
  const t = tree(["hooks/handler.sh", "extras.txt"], ["hooks"]);
  eq("extras.txt silenced by ignore", runHeuristics(m, t).some((h) => h.includes("extras.txt")), false);
}
{
  const m = baseManifest();
  const t = tree(["hooks/handler.sh", "weird/foo.txt"], ["hooks", "weird"]);
  eq("non-well-known dir now scanned", runHeuristics(m, t).some((h) => h.includes("weird/foo.txt")), true);
}
{
  const m = baseManifest();
  const t = tree(["hooks/handler.sh"], ["hooks"]);
  eq("referenced path no warning", runHeuristics(m, t).length, 0);
}

console.log("\n=== FNM_PATHNAME bracket-class semantics ===");

// Bracket expressions must NEVER match `/` under FNM_PATHNAME, even when `/` is
// listed inside the class — POSIX rules out class-driven slash matching.
{
  const m = baseManifest({ ignore: ["docs[/x]"] });
  const t = tree(["hooks/handler.sh", "docs/foo.md", "docsx"], ["hooks", "docs"]);
  const hints = runHeuristics(m, t);
  // POSIX: docs[/x] matches `docsx` (literal x in class) but never `docs/foo.md`.
  eq("[/x] matches docsx (literal class member)", hints.some((h) => h.includes("docsx")), false);
  eq("[/x] does NOT match docs/foo.md (slash via class forbidden)", hints.some((h) => h.includes("docs/foo.md")), true);
}

// Negated class must also exclude `/` — even with `[!a]`, `/` should not match.
{
  // Pattern `foo[!a]` should NOT match `foo/`. Embed in a context the test can verify.
  // We pick a pattern where matching `/` would silence a path it shouldn't.
  const m = baseManifest({ ignore: ["foo[!a]"] });
  const t = tree(["hooks/handler.sh", "foob", "foo/x"], ["hooks", "foo"]);
  const hints = runHeuristics(m, t);
  // `foo[!a]` matches `foob` (b is not a) — silenced.
  eq("[!a] matches foob (negated class)", hints.some((h) => h.includes("foob") && !h.includes("foo/")), false);
}

console.log("\n=== Backslash escape (mcs FNM_PATHNAME, no FNM_NOESCAPE) ===");

{
  const m = baseManifest({ ignore: ["foo\\*"] });
  const t = tree(["hooks/handler.sh", "foo*", "fooXY"], ["hooks"]);
  const hints = runHeuristics(m, t);
  eq("foo\\* matches literal foo*", hints.some((h) => h.includes("foo*")), false);
  eq("foo\\* does NOT match fooXY", hints.some((h) => h.includes("fooXY")), true);
}

console.log("\n=== Robustness ===");

{
  const r = validateTechpackYaml(yamlOf(baseManifest({ ignore: ["[\\]"] })));
  eq("malformed pattern returns validation error", r.valid, false);
  eq("error mentions not a valid pattern", r.errors.some((e) => e.includes("not a valid pattern")), true);
}
{
  const m = { ...baseManifest(), ignore: ["[\\]"] };
  const t = tree(["hooks/handler.sh", "docs/foo.md"], ["hooks", "docs"]);
  let threw = false;
  let hints: string[] = [];
  try {
    hints = runHeuristics(m, t);
  } catch {
    threw = true;
  }
  eq("runHeuristics tolerates invalid ignore pattern (defensive shield)", threw, false);
  eq("runHeuristics still emits hints when ignore is invalid", hints.length > 0, true);
}
{
  const yaml = JSON.stringify({
    schemaVersion: 1,
    identifier: "x",
    displayName: "x",
    description: "x",
    components: {},
    ignore: ["docs/"],
  });
  let threw = false;
  let r: ReturnType<typeof validateTechpackYaml> | undefined;
  try {
    r = validateTechpackYaml(yaml);
  } catch {
    threw = true;
  }
  eq("malformed components type doesn't crash", threw, false);
  eq("returns structured validation errors", r?.valid, false);
}
{
  const m = baseManifest();
  const files = ["hooks/handler.sh"];
  for (let i = 0; i < 100; i++) files.push(`extras/file${i}.txt`);
  const t = tree(files, ["hooks", "extras"]);
  const hints = runHeuristics(m, t);
  eq("hints capped at 50 plus truncation marker", hints.length, 51);
  eq("last hint is truncation marker", hints[50].includes("truncated"), true);
}

console.log("\n=== validateTechpackYaml: hook metadata + doctor checks ===");

function hookComp(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gate",
    description: "x",
    hookEvent: "PreToolUse",
    hook: { source: "hooks/gate.js", destination: "gate.js" },
    ...extra,
  };
}
const withComps = (...components: Record<string, unknown>[]) => baseManifest({ components });

{
  const r = validateTechpackYaml(yamlOf(withComps({ id: "c", description: "x", hook: { source: "a", destination: "a" }, hookInterpreter: "node" })));
  eq("hookInterpreter without hookEvent rejected", r.errors.includes("Component 'c': hookInterpreter requires hookEvent"), true);
}
{
  const r = validateTechpackYaml(yamlOf(withComps({ id: "c", description: "x", hook: { source: "a", destination: "a" }, hookMatcher: "Bash" })));
  eq("hookMatcher without hookEvent rejected", r.errors.includes("Component 'c': hookMatcher requires hookEvent"), true);
}
for (const [value, expected] of [
  ["node --experimental-strip-types", null],
  ["node --experimental-strip-types --disable-warning=ExperimentalWarning", null],
  ["/usr/bin/env node", null],
  ["n".repeat(200), null],
  ["/opt/homebrew/bin/bun run", null],
  ["  uv run  ", null],
  ["   ", "Component 'gate': hookInterpreter must not be empty — omit it to use bash"],
  ["node\nrm -rf /", "Component 'gate': hookInterpreter must not contain control characters or line breaks (found U+000A)"],
  ["node\t-e", "Component 'gate': hookInterpreter must not contain control characters or line breaks (found U+0009)"],
  ["./bin/node", "Component 'gate': hookInterpreter binary './bin/node' must be a bare command name or an absolute path, without shell metacharacters"],
  ["node;rm", "Component 'gate': hookInterpreter binary 'node;rm' must be a bare command name or an absolute path, without shell metacharacters"],
  ["node $(x)", "Component 'gate': hookInterpreter argument '$(x)' must be a plain flag or word, without shell metacharacters — use a wrapper script for anything else"],
  ["n".repeat(201), "Component 'gate': hookInterpreter must be at most 200 characters (got 201)"],
] as const) {
  const r = validateTechpackYaml(yamlOf(withComps(hookComp({ hookInterpreter: value }))));
  eq(`hookInterpreter ${JSON.stringify(value).slice(0, 40)}`, r.errors, expected === null ? [] : [expected]);
}
{
  const r = validateTechpackYaml("schemaVersion: 1\nidentifier: test\ndisplayName: Test\ndescription: d\ncomponents:\n  - id: c\n    description: x\n    brew: jq\n    hookInterpreter:\n    hookMatcher: ~\n");
  eq("blank hook fields count as absent, like decodeIfPresent", r.errors, []);
}
{
  const check = { type: "hookEventExists", name: "hook registered", event: "PreToolUse", matcher: "" };
  const r = validateTechpackYaml(yamlOf(baseManifest({ supplementaryDoctorChecks: [check] })));
  eq(
    "empty hookEventExists matcher rejected",
    r.errors,
    ["Invalid doctor check 'hook registered': hookEventExists 'matcher' must be non-empty — omit it to skip the assertion"]
  );
}
{
  const check = { type: "hookEventExists", name: "hook registered", event: "PreToolUse", command: "" };
  const r = validateTechpackYaml(yamlOf(withComps(hookComp({ doctorChecks: [check] }))));
  eq("empty hookEventExists command on component check rejected", r.errors, [
    "Invalid doctor check 'hook registered': hookEventExists 'command' must be non-empty — omit it to skip the assertion",
  ]);
}

console.log("\n=== runHeuristics: mcs 2026.9 warnings ===");

const noTree = tree([]);

{
  const hints = runHeuristics(withComps({ id: "t", description: "x", brew: "someone/tools/thing" }), noTree);
  eq("third-party tap warned", hints, [
    "Component 't' installs 'someone/tools/thing' from third-party tap 'someone/tools' — 'mcs sync' taps it without confirmation from Homebrew or mcs.",
  ]);
  eq("homebrew/ tap not warned", runHeuristics(withComps({ id: "t", description: "x", brew: "Homebrew/core/jq" }), noTree), []);
  eq("URL form not warned", runHeuristics(withComps({ id: "t", description: "x", brew: "https://x/y/z" }), noTree), []);
}
{
  const m = baseManifest({
    components: [{ id: "c", description: "x", brew: "jq" }],
    supplementaryDoctorChecks: [
      { type: "commandExists", name: "jq", command: "jq", scope: "global", matcher: "x" },
      { type: "settingsKeyEquals", name: "k", keyPath: "a", expectedValue: "b", scope: "project" },
      { type: "fileExists", name: "f", path: "x", scope: "project" },
    ],
  });
  eq("scope/matcher on types that ignore them", runHeuristics(m, noTree), [
    "Doctor check 'jq' declares `scope` but type `commandExists` ignores it — `scope` only applies to checks with a `path`",
    "Doctor check 'k' declares `scope` but type `settingsKeyEquals` ignores it — settings are resolved from the project root automatically (project settings.local.json, then global settings.json)",
    "Doctor check 'jq' declares `matcher` but type `commandExists` ignores it — `matcher` applies only to `hookEventExists`",
  ]);
}
{
  const ts = hookComp({ hook: { source: "hooks/gate.ts", destination: "gate.ts" } });
  eq("ambiguous .ts hook warned", runHeuristics(withComps(ts), noTree), [
    "Hook 'gate' installs 'gate.ts' but declares no hookInterpreter — it will run under bash. TypeScript has no single default; declare one (e.g. `hookInterpreter: node --experimental-strip-types`).",
  ]);
  const jsDestTsSource = hookComp({ hook: { source: "hooks/gate.ts", destination: "gate.js" } });
  eq(".js destination decides over .ts source", runHeuristics(withComps(jsDestTsSource, { id: "n", description: "x", brew: "node" }), noTree), []);
}
{
  eq("node hook without brew node warned", runHeuristics(withComps(hookComp()), noTree), [
    "Hook 'gate' uses node but no brew component installs node",
  ]);
  eq("tap-qualified node satisfies node hook", runHeuristics(withComps(hookComp(), { id: "n", description: "x", brew: "homebrew/core/node@22" }), noTree), []);
  const py = hookComp({ id: "py", hook: { source: "hooks/p.py", destination: "p.py" } });
  eq("brew python satisfies python3 hook", runHeuristics(withComps(py, { id: "b", description: "x", brew: "python@3.12" }), noTree), []);
  const envHook = hookComp({ id: "e", hookInterpreter: "/usr/bin/env -u X FOO=1 deno run" });
  eq("env looked through for binary", runHeuristics(withComps(envHook), noTree), ["Hook 'e' uses deno but no brew component installs deno"]);
  const twoNode = withComps(hookComp(), hookComp({ id: "gate2", hook: { source: "hooks/b.js", destination: "b.js" } }));
  eq("runtime warning deduped per binary", runHeuristics(twoNode, noTree).length, 1);
  const bashHook = hookComp({ hook: { source: "hooks/x", destination: "x" } });
  eq("extensionless hook defaults to bash, not reported", runHeuristics(withComps(bashHook), noTree), []);
}
{
  const check = { type: "hookEventExists", name: "gate registered", event: "PreToolUse", command: "bash .claude/hooks/gate.js" };
  const m = withComps(hookComp({ doctorChecks: [check] }), { id: "n", description: "x", brew: "node" });
  eq("doctor check contradicting interpreter warned", runHeuristics(m, noTree), [
    "Doctor check 'gate registered' asserts command 'bash .claude/hooks/gate.js' but hook 'gate' is registered with 'node' — the check will never match",
  ]);
  const pathOnly = { ...check, command: "gate.js" };
  eq("path-only assertion not warned", runHeuristics(withComps(hookComp({ doctorChecks: [pathOnly] }), { id: "n", description: "x", brew: "node" }), noTree), []);
  const unrelated = baseManifest({
    components: [hookComp(), { id: "n", description: "x", brew: "node" }],
    supplementaryDoctorChecks: [{ ...check, command: "bash .claude/hooks/other.sh" }],
  });
  eq("uncorrelated supplementary check not paired", runHeuristics(unrelated, noTree), []);
}
{
  const verboseHook = {
    id: "v",
    description: "x",
    type: "hookFile",
    hookEvent: "Stop",
    installAction: { type: "copyPackFile", source: "hooks/v.js", destination: "v.js", fileType: "hook" },
  };
  eq("long-form copyPackFile hook resolved", runHeuristics(withComps(verboseHook), noTree), ["Hook 'v' uses node but no brew component installs node"]);
  const verboseBrew = { id: "b", description: "x", type: "brewPackage", installAction: { type: "brewInstall", package: "node" } };
  eq("long-form brewInstall satisfies runtime", runHeuristics(withComps(verboseHook, verboseBrew), noTree), []);
  const verboseMcp = { id: "m", description: "x", type: "mcpServer", installAction: { type: "mcpServer", name: "srv", command: "npx" } };
  eq("long-form mcpServer checked", runHeuristics(withComps(verboseMcp), noTree), ["MCP server 'srv' uses node but no brew component installs node"]);

  const notHookFile = { ...verboseHook, id: "g", type: "command" };
  eq("non-hookFile type ignored", runHeuristics(withComps(notHookFile), noTree), []);
  eq("hookFile without hookEvent ignored", runHeuristics(withComps({ ...verboseHook, hookEvent: undefined }), noTree), []);
  const genericFile = { ...verboseHook, installAction: { ...verboseHook.installAction, fileType: "generic" } };
  eq("fileType other than hook ignored", runHeuristics(withComps(genericFile), noTree), []);

  const via = (source: string, destination: string) => runHeuristics(withComps(hookComp({ hook: { source, destination } })), noTree);
  eq("extensionless destination falls back to .py source", via("hooks/p.py", "p"), ["Hook 'gate' uses python3 but no brew component installs python3"]);
  eq("unknown destination extension does not fall back", via("hooks/p.py", "p.bin"), []);
  eq("extension match is case-insensitive", via("hooks/g.JS", "g.JS"), ["Hook 'gate' uses node but no brew component installs node"]);
}
{
  const m = baseManifest({
    components: [{ id: "c", description: "x", brew: "jq", isRequired: true, dependencies: [] }],
    templates: [{ sectionIdentifier: "s", contentFile: "t.md", dependencies: ["c"], isRequired: false }],
  });
  eq("deprecated keys warned on components and templates", runHeuristics(m, tree(["t.md"])), [
    "Component 'c' declares `isRequired`, which is deprecated and ignored — packs install every component, in declaration order",
    "Component 'c' declares `dependencies`, which is deprecated and ignored — packs install every component, in declaration order",
    "Template 's' declares `isRequired`, which is deprecated and ignored — packs install every component, in declaration order",
    "Template 's' declares `dependencies`, which is deprecated and ignored — packs install every component, in declaration order",
  ]);
  const r = validateTechpackYaml(yamlOf(withComps({ id: "c", description: "x", brew: "jq", dependencies: ["missing"], isRequired: true })));
  eq("deprecated keys do not fail validation", r.errors, []);
}
{
  const mcp = (command: string) => ({ id: "srv", description: "x", mcp: { command } });
  eq("npx satisfied by tap-qualified node", runHeuristics(withComps(mcp("npx"), { id: "n", description: "x", brew: "someone/tap/node" }), noTree).filter((h) => h.startsWith("MCP")), []);
  eq("python3 MCP satisfied by brew python", runHeuristics(withComps(mcp("python3"), { id: "b", description: "x", brew: "python" }), noTree), []);
  eq("python MCP gap uses mcs wording", runHeuristics(withComps(mcp("/usr/bin/python3")), noTree), [
    "MCP server 'srv' uses python but no brew component installs python",
  ]);
}

console.log("\n=== Built-in list drift (parity contract with mcs) ===");

const REQUIRED_IGNORED_DIRS = [".git", ".github", ".gitlab", ".vscode", "node_modules", "__pycache__", ".build"];
const REQUIRED_INFRA_FILES = [
  "techpack.yaml",
  "README.md",
  "README",
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  ".gitignore",
  ".editorconfig",
  "package.json",
  "package-lock.json",
  "requirements.txt",
  "Makefile",
  "Dockerfile",
  ".dockerignore",
];
for (const d of REQUIRED_IGNORED_DIRS) eq(`BUILTIN_IGNORED_DIRS contains ${d}`, BUILTIN_IGNORED_DIRS.has(d), true);
for (const f of REQUIRED_INFRA_FILES) eq(`BUILTIN_INFRASTRUCTURE_FILES contains ${f}`, BUILTIN_INFRASTRUCTURE_FILES.has(f), true);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
