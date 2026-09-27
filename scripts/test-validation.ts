/**
 * Live smoke test: runs the registry's pack evaluation against real GitHub tech pack repos,
 * without writing anything. Run: npx tsx scripts/test-validation.ts
 */
import { execSync } from "child_process";
import { evaluateRepo } from "../src/lib/packValidation.js";
import { fetchRepoMetadata } from "../src/lib/github.js";

const GITHUB_TOKEN = execSync("gh auth token", { encoding: "utf-8" }).trim();

const REGISTRY_API = "https://techpacks.mcs-cli.dev/api/packs?include=all&limit=100";

// Extra packs to test (not in the registry — add URLs here for manual testing)
const EXTRA_PACKS: string[] = [];

interface TestResult {
  repo: string;
  status: "active" | "invalid" | "error";
  errors: string[];
  warnings: string[];
}

async function testPack(repoUrl: string, label: string): Promise<TestResult> {
  process.stdout.write(`  ${repoUrl} — ${label} ... `);
  try {
    const metadata = await fetchRepoMetadata(repoUrl, GITHUB_TOKEN);
    if (!metadata) {
      console.log("❌ repo not found");
      return { repo: repoUrl, status: "error", errors: ["Repo not found"], warnings: [] };
    }
    const evaluation = await evaluateRepo(metadata.owner, metadata.repo, metadata.defaultBranch, GITHUB_TOKEN);
    console.log(evaluation.status === "active" ? "✅ active" : "❌ invalid");
    for (const err of evaluation.errors) console.log(`       ✖ ${err}`);
    for (const warn of evaluation.warnings) console.log(`       ⚠️  ${warn}`);
    return { repo: repoUrl, ...evaluation };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`🔥 ${message}`);
    return { repo: repoUrl, status: "error", errors: [message], warnings: [] };
  }
}

async function main() {
  console.log("=== MCS Registry Validation Smoke Test ===\n");

  const results: TestResult[] = [];
  for (const url of EXTRA_PACKS) results.push(await testPack(url, "manual test"));

  console.log(`Fetching packs from ${REGISTRY_API}...`);
  const res = await fetch(REGISTRY_API);
  if (!res.ok) {
    console.log(`Registry API returned HTTP ${res.status} — cannot fetch packs`);
    return;
  }
  const data = (await res.json()) as { packs: Array<{ repoUrl: string; displayName: string; status: string }> };
  console.log(`Found ${data.packs.length} packs\n`);
  for (const pack of data.packs) {
    results.push(await testPack(pack.repoUrl, `"${pack.displayName}" [${pack.status}]`));
  }

  console.log("\n=== Summary ===\n");
  console.log(`  ✅ Active:        ${results.filter((r) => r.status === "active").length}`);
  console.log(`  ❌ Invalid:       ${results.filter((r) => r.status === "invalid").length}`);
  console.log(`  ⚠️  With warnings: ${results.filter((r) => r.warnings.length > 0).length}`);
  console.log(`  🔥 Errors:        ${results.filter((r) => r.status === "error").length}`);
}

main().catch(console.error);
