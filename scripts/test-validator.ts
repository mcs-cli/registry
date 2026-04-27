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
