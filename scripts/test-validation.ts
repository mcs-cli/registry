/**
 * Test file-existence validation against real GitHub tech pack repos.
 * Run: npx tsx scripts/test-validation.ts
 */
import { execSync } from "child_process";
import { validateTechpackYaml, validateFileReferences } from "../src/lib/validator.js";
import type { RepoTree } from "../src/types.js";

const GITHUB_TOKEN = execSync("gh auth token", { encoding: "utf-8" }).trim();

const HEADERS: Record<string, string> = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "User-Agent": "mcs-registry-test",
};

const REGISTRY_API = "https://techpacks.mcs-cli.dev/api/packs";

// Extra packs to test (not in the registry)
const EXTRA_PACKS = [
  "https://github.com/mshadmanrahman/morning-digest",
];

// -- GitHub API helpers --

async function fetchDefaultBranch(owner: string, repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { ...HEADERS, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    console.log(`    ⚠️  Repo fetch failed: HTTP ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { default_branch: string };
  return data.default_branch;
}

async function fetchTechpackYaml(owner: string, repo: string, branch: string): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/techpack.yaml?ref=${branch}`,
    { headers: { ...HEADERS, Accept: "application/vnd.github.v3.raw" } }
  );
  if (!res.ok) return null;
  return res.text();
}

async function fetchRepoTree(owner: string, repo: string, branch: string): Promise<RepoTree | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: { ...HEADERS, Accept: "application/vnd.github+json" } }
  );
  if (!res.ok) {
    console.log(`    Tree fetch failed: HTTP ${res.status}`);
    return null;
  }
  const json = (await res.json()) as { tree: Array<{ path: string; type: string }>; truncated: boolean };
  if (json.truncated) {
    console.log(`    Tree truncated (${json.tree.length} entries) — would skip in production`);
    return null;
  }
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const entry of json.tree) {
    if (entry.type === "blob") files.add(entry.path);
    else if (entry.type === "tree") directories.add(entry.path);
  }
  return { files, directories };
}

// -- Validation runner --

interface TestResult {
  repo: string;
  status: "valid" | "invalid" | "error" | "no-techpack";
  errors: string[];
  warnings: string[];
  components: string;
}

async function testPack(repoUrl: string, label: string): Promise<TestResult> {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    console.log(`  SKIP: Invalid URL ${repoUrl}`);
    return { repo: repoUrl, status: "error", errors: ["Invalid URL"], warnings: [], components: "" };
  }
  const [, owner, repo] = match;
  const fullName = `${owner}/${repo}`;
  process.stdout.write(`  ${fullName} — ${label} ... `);

  // 1. Default branch
  const branch = await fetchDefaultBranch(owner, repo);
  if (!branch) {
    console.log("❌ repo not found");
    return { repo: fullName, status: "error", errors: ["Repo not found"], warnings: [], components: "" };
  }

  // 2. Fetch techpack.yaml
  const yaml = await fetchTechpackYaml(owner, repo, branch);
  if (!yaml) {
    console.log("❌ no techpack.yaml");
    return { repo: fullName, status: "no-techpack", errors: [], warnings: [], components: "" };
  }

  // 3. Structural validation
  const validation = validateTechpackYaml(yaml);
  if (!validation.valid || !validation.packData) {
    console.log("❌ structural");
    for (const err of validation.errors) console.log(`       ${err}`);
    return { repo: fullName, status: "invalid", errors: validation.errors, warnings: [], components: "" };
  }

  const counts = validation.packData.components;
  const parts = Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`);
  const componentsStr = parts.join(", ") || "none";

  // 4. File-existence validation
  const tree = await fetchRepoTree(owner, repo, branch);
  if (!tree || !validation.manifest) {
    console.log(`✅ structural (file validation skipped) — ${componentsStr}`);
    return { repo: fullName, status: "valid", errors: [], warnings: ["File validation skipped"], components: componentsStr };
  }

  const fileValidation = validateFileReferences(validation.manifest, tree);

  if (fileValidation.errors.length > 0) {
    console.log(`❌ missing files — ${componentsStr}`);
    for (const err of fileValidation.errors) console.log(`       ${err}`);
    for (const warn of fileValidation.warnings) console.log(`       ⚠️  ${warn}`);
    return { repo: fullName, status: "invalid", errors: fileValidation.errors, warnings: fileValidation.warnings, components: componentsStr };
  }

  if (fileValidation.warnings.length > 0) {
    console.log(`✅ with warnings — ${componentsStr}`);
    for (const warn of fileValidation.warnings) console.log(`       ⚠️  ${warn}`);
    return { repo: fullName, status: "valid", errors: [], warnings: fileValidation.warnings, components: componentsStr };
  }

  console.log(`✅ all files verified — ${componentsStr}`);
  return { repo: fullName, status: "valid", errors: [], warnings: [], components: componentsStr };
}

// -- Main --

async function main() {
  console.log("=== MCS Registry File-Existence Validation Test ===\n");

  const results: TestResult[] = [];

  // Test extra packs (not in registry — known problematic ones)
  if (EXTRA_PACKS.length > 0) {
    console.log("--- Extra packs (not in registry) ---\n");
    for (const url of EXTRA_PACKS) {
      const result = await testPack(url, "manual test");
      results.push(result);
    }
    console.log("");
  }

  // Test against all packs in the live registry
  console.log(`Fetching packs from ${REGISTRY_API}...`);
  const res = await fetch(REGISTRY_API);
  if (!res.ok) {
    console.log(`Registry API returned HTTP ${res.status} — cannot fetch packs`);
    return;
  }

  const data = (await res.json()) as { packs: Array<{ slug: string; repoUrl: string; displayName: string; status: string }> };
  console.log(`Found ${data.packs.length} packs\n`);

  for (const pack of data.packs) {
    const result = await testPack(pack.repoUrl, `"${pack.displayName}" [${pack.status}]`);
    results.push(result);
  }

  // Summary
  console.log("\n\n=== Summary ===\n");
  const valid = results.filter((r) => r.status === "valid");
  const invalid = results.filter((r) => r.status === "invalid");
  const errors = results.filter((r) => r.status === "error");
  const noTechpack = results.filter((r) => r.status === "no-techpack");
  const withWarnings = results.filter((r) => r.warnings.length > 0 && r.status === "valid");

  console.log(`  ✅ Valid:        ${valid.length}`);
  console.log(`  ❌ Invalid:      ${invalid.length}`);
  console.log(`  ⚠️  With warnings: ${withWarnings.length}`);
  console.log(`  💀 No techpack:  ${noTechpack.length}`);
  console.log(`  🔥 Errors:       ${errors.length}`);

  if (invalid.length > 0) {
    console.log("\n  Packs that would be marked INVALID:");
    for (const r of invalid) {
      console.log(`    ${r.repo}:`);
      for (const err of r.errors) console.log(`      - ${err}`);
    }
  }

  if (withWarnings.length > 0) {
    console.log("\n  Packs with warnings:");
    for (const r of withWarnings) {
      console.log(`    ${r.repo}:`);
      for (const warn of r.warnings) console.log(`      - ${warn}`);
    }
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
