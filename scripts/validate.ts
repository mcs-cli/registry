/**
 * Validation of all registered tech packs — the only scheduled writer of each pack's
 * status (active/invalid), warnings and validationErrors (reindex only restores the last verdict
 * of a pack that comes back from unavailable). Runs in the Reindex & Validate
 * workflow right after the metadata reindex, so pushedAt and defaultBranch are fresh.
 *
 * Usage: npx tsx scripts/validate.ts
 *
 * Required env vars:
 *   GITHUB_TOKEN          — GitHub token for API access and issue filing (provided by Actions)
 *   REGISTRY_URL          — Registry API base URL (e.g., https://techpacks.mcs-cli.dev)
 *   REINDEX_SECRET        — Auth token for the update-status endpoint
 */
import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { evaluateRepo } from "../src/lib/packValidation.js";
import type { ExtractedPackData } from "../src/types.js";
import type { UpdatePackStatusRequest } from "../src/api/packs.js";
import { GitHubApiError, parseGitHubUrl } from "../src/lib/github.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const REGISTRY_URL = process.env.REGISTRY_URL ?? "https://techpacks.mcs-cli.dev";
const REINDEX_SECRET = process.env.REINDEX_SECRET ?? "";
const REGISTRY_REPO = "mcs-cli/registry";

if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

if (!REINDEX_SECRET) {
  console.warn("WARNING: REINDEX_SECRET not set — running in dry-run mode (no status updates will be written)");
}

const GH_HEADERS: Record<string, string> = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "mcs-registry-validator",
};

// -- Types --

interface PackInfo {
  slug: string;
  repoUrl: string;
  displayName: string;
  status: string;
  defaultBranch: string;
  pushedAt: string;
  deepValidatedAt?: string;
  validatorVersion?: string;
}

interface ValidationReport {
  slug: string;
  displayName: string;
  previousStatus: string;
  newStatus: "active" | "invalid";
  errors: string[];
  warnings: string[];
  packData?: ExtractedPackData;
  statusChanged: boolean;
}

// -- Skip logic --

const FORCE_ALL = process.env.FORCE_ALL === "true";

// A digest rather than a hand-bumped number, so no validator change can ship without re-checking every pack.
const VALIDATOR_VERSION = validatorDigest();

function validatorDigest(): string {
  const root = new URL("../", import.meta.url);
  const sources = [
    ...readdirSync(new URL("src/lib/", root)).filter((f) => f.endsWith(".ts")).sort().map((f) => `src/lib/${f}`),
    "schema/techpack-schema.json",
  ];
  const hash = createHash("sha256");
  for (const path of sources) hash.update(path).update("\0").update(readFileSync(new URL(path, root))).update("\0");
  return hash.digest("hex").slice(0, 16);
}

// A verdict depends only on the pushed content and the validator, so a pack is re-checked only
// when either has changed since its last verdict.
function canSkipValidation(pack: PackInfo): boolean {
  if (FORCE_ALL || !pack.deepValidatedAt || !pack.pushedAt) return false;
  if (pack.validatorVersion !== VALIDATOR_VERSION) return false;
  return new Date(pack.pushedAt).getTime() <= new Date(pack.deepValidatedAt).getTime();
}

// -- Registry API --

// The listing caps `limit` at 100, so page until `total` is reached.
async function fetchAllPacks(): Promise<PackInfo[]> {
  const pageSize = 100;
  const packs: PackInfo[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(`${REGISTRY_URL}/api/packs?include=all&limit=${pageSize}&offset=${offset}`);
    if (!res.ok) throw new Error(`Registry API returned HTTP ${res.status}`);
    const data = (await res.json()) as { packs: PackInfo[]; total: number };
    packs.push(...data.packs);
    if (data.packs.length === 0 || packs.length >= data.total) return packs;
  }
}

async function updatePackStatus(payload: UpdatePackStatusRequest): Promise<boolean> {
  if (!REINDEX_SECRET) {
    console.log(`  [dry-run] Would update ${payload.slug} → ${payload.status}`);
    return true;
  }
  const res = await fetch(`${REGISTRY_URL}/api/packs/update-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${REINDEX_SECRET}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`  Failed to update ${payload.slug}: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
    return false;
  }
  return true;
}

// -- Issue filing (on the registry repo) --

const ISSUE_TAG = "[Validation]";

async function hasOpenIssue(slug: string): Promise<boolean> {
  const query = encodeURIComponent(`repo:${REGISTRY_REPO} is:issue is:open "${ISSUE_TAG} ${slug}" in:title`);
  const res = await fetch(`https://api.github.com/search/issues?q=${query}&per_page=1`, {
    headers: GH_HEADERS,
  });
  if (!res.ok) {
    console.warn(`  Warning: issue search failed for ${slug} (HTTP ${res.status}) — skipping to avoid duplicates`);
    return true;
  }
  const data = (await res.json()) as { total_count: number };
  return data.total_count > 0;
}

async function createGitHubIssue(title: string, body: string, labels?: string[]): Promise<string | null> {
  const payload: Record<string, unknown> = { title, body };
  if (labels) payload.labels = labels;

  const res = await fetch(`https://api.github.com/repos/${REGISTRY_REPO}/issues`, {
    method: "POST",
    headers: { ...GH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    // 422 can mean the label doesn't exist yet — retry without labels
    if (res.status === 422 && labels) {
      console.warn(`  Issue creation got 422, retrying without labels`);
      return createGitHubIssue(title, body);
    }
    console.error(`  Failed to create issue: HTTP ${res.status}${errorBody ? ` — ${errorBody}` : ""}`);
    return null;
  }
  const data = (await res.json()) as { html_url: string };
  return data.html_url;
}

async function fileIssue(report: ValidationReport, repoUrl: string): Promise<string | null> {
  const errorList = report.errors.map((e) => `- ${e}`).join("\n");
  const warningList = report.warnings.length > 0
    ? `\n### Warnings\n\n${report.warnings.map((w) => `- ${w}`).join("\n")}\n`
    : "";

  const body = `## Validation failed for ${report.displayName}

**Pack:** \`${report.slug}\`
**Repo:** ${repoUrl}
**Previous status:** ${report.previousStatus}

### Errors

${errorList}
${warningList}
### How to fix

1. Run \`mcs pack validate\` in the pack's checkout — the registry applies the same checks, so it reports the same errors
2. Push the fix to the default branch — the registry will automatically re-validate on the next cycle

Once the issues are resolved, this pack will be restored to **active** status and this issue can be closed.

---
*Filed automatically by the [Reindex & Validate workflow](https://github.com/${REGISTRY_REPO}/actions/workflows/reindex.yml)*`;

  return createGitHubIssue(
    `${ISSUE_TAG} ${report.slug} — validation failed`,
    body,
    ["validation"],
  );
}

type IssueResult =
  | { slug: string; type: "filed"; url: string }
  | { slug: string; type: "skipped" }
  | { slug: string; type: "failed" };

async function fileIssuesForNewlyInvalid(reports: ValidationReport[], packs: PackInfo[]): Promise<IssueResult[]> {
  const results: IssueResult[] = [];
  const newlyInvalid = reports.filter((r) => r.statusChanged && r.newStatus === "invalid");
  if (newlyInvalid.length === 0) return results;
  if (!REINDEX_SECRET) {
    console.log(`\n[dry-run] Would file issues for ${newlyInvalid.length} newly invalid pack(s)`);
    return results;
  }

  console.log(`\nFiling issues for ${newlyInvalid.length} newly invalid pack(s)...`);

  for (const report of newlyInvalid) {
    const pack = packs.find((p) => p.slug === report.slug);
    if (!pack) continue;

    const existing = await hasOpenIssue(report.slug);
    if (existing) {
      console.log(`  ${report.slug} — open issue already exists, skipping`);
      results.push({ slug: report.slug, type: "skipped" });
      continue;
    }

    const issueUrl = await fileIssue(report, pack.repoUrl);
    if (issueUrl) {
      console.log(`  ${report.slug} — issue filed: ${issueUrl}`);
      results.push({ slug: report.slug, type: "filed", url: issueUrl });
    } else {
      console.log(`  ${report.slug} — failed to file issue`);
      results.push({ slug: report.slug, type: "failed" });
    }
  }

  return results;
}

// -- Main --

async function validatePack(pack: PackInfo): Promise<ValidationReport> {
  const parsed = parseGitHubUrl(pack.repoUrl);
  if (!parsed) throw new Error(`Invalid repo URL '${pack.repoUrl}'`);
  const { owner, repo } = parsed;
  const evaluation = await evaluateRepo(owner, repo, pack.defaultBranch, GITHUB_TOKEN);

  return {
    slug: pack.slug,
    displayName: pack.displayName,
    previousStatus: pack.status,
    newStatus: evaluation.status,
    errors: evaluation.errors,
    warnings: evaluation.warnings,
    packData: evaluation.packData,
    statusChanged: evaluation.status !== pack.status,
  };
}

async function main() {
  console.log("=== MCS Registry Validation ===\n");

  const packs = await fetchAllPacks();
  console.log(`Found ${packs.length} packs\n`);

  const reports: ValidationReport[] = [];
  const failures: Array<{ slug: string; message: string }> = [];
  const writeFailures: string[] = [];
  let skippedCount = 0;
  let aborted: unknown;

  for (const pack of packs) {
    process.stdout.write(`  ${pack.slug} ... `);

    if (pack.status === "unavailable") {
      console.log("⏭️  SKIPPED (unavailable — owned by reindex)");
      skippedCount++;
      continue;
    }
    if (canSkipValidation(pack)) {
      console.log(`⏭️  SKIPPED (not pushed since last validation)`);
      skippedCount++;
      continue;
    }

    let report: ValidationReport;
    try {
      report = await validatePack(pack);
    } catch (err) {
      // A rate limit would fail every remaining pack the same way — stop and let the next run retry,
      // but still file issues for the packs already written invalid, or they would never get one.
      if (err instanceof GitHubApiError && err.isRateLimit) {
        console.log(`🛑 ABORTED: ${err.message}`);
        aborted = err;
        break;
      }
      // Any other fetch failure says nothing about the pack, so its stored verdict stays as is.
      const message = err instanceof Error ? err.message : String(err);
      console.log(`⚠️  NOT VALIDATED: ${message}`);
      failures.push({ slug: pack.slug, message });
      continue;
    }
    const icon = report.newStatus === "active" ? "✅" : "❌";
    const extras = report.warnings.length > 0 ? ` (${report.warnings.length} warnings)` : "";
    console.log(`${icon} ${report.newStatus}${extras}`);

    const updated = await updatePackStatus({
      slug: report.slug,
      status: report.newStatus,
      warnings: report.warnings,
      validationErrors: report.errors,
      deepValidatedAt: new Date().toISOString(),
      validatorVersion: VALIDATOR_VERSION,
      packData: report.packData,
    });
    // An unrecorded verdict is not a validation: no count, no issue.
    if (!updated) {
      console.log(`    ⚠️  Failed to update status for ${report.slug}`);
      writeFailures.push(report.slug);
      continue;
    }
    reports.push(report);
  }

  // Summary
  const valid = reports.filter((r) => r.newStatus === "active");
  const invalid = reports.filter((r) => r.newStatus === "invalid");
  const changed = reports.filter((r) => r.statusChanged);
  const withWarnings = reports.filter((r) => r.warnings.length > 0 && r.newStatus === "active");

  console.log("\n=== Summary ===\n");
  console.log(`  Total:           ${packs.length}`);
  console.log(`  Skipped:         ${skippedCount}`);
  console.log(`  Validated:       ${reports.length}`);
  console.log(`  Not validated:   ${failures.length}`);
  console.log(`  Valid:           ${valid.length}`);
  console.log(`  Invalid:         ${invalid.length}`);
  console.log(`  Status changed:  ${changed.length}`);
  console.log(`  With warnings:   ${withWarnings.length}`);

  // File issues for newly invalid packs (before step summary so we can include links)
  const issueResults = await fileIssuesForNewlyInvalid(reports, packs);

  // GitHub Actions step summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { writeFileSync } = await import("fs");
    const lines: string[] = [];

    // Overview table
    lines.push(
      `## Validation Report\n`,
      `| Metric | Count |\n|--------|-------|`,
      `| Total packs | ${packs.length} |`,
      `| Skipped (not pushed, or unavailable) | ${skippedCount} |`,
      `| Validated | ${reports.length} |`,
      `| Not validated (GitHub error) | ${failures.length} |`,
      `| Status update failed | ${writeFailures.length} |`,
      `| Active | ${valid.length} |`,
      `| Invalid | ${invalid.length} |`,
      `| Status changed | ${changed.length} |`,
      `| With warnings | ${withWarnings.length} |\n`,
    );

    // Per-pack results table
    lines.push(`### Pack Results\n`, `| Pack | Status | Issues |\n|------|--------|--------|`);
    for (const r of reports) {
      const icon = r.newStatus === "active" ? "pass" : "FAIL";
      const change = r.statusChanged ? ` (was ${r.previousStatus})` : "";
      const issues: string[] = [];
      if (r.errors.length > 0) issues.push(`${r.errors.length} error(s)`);
      if (r.warnings.length > 0) issues.push(`${r.warnings.length} warning(s)`);
      lines.push(`| \`${r.slug}\` | ${icon}${change} | ${issues.join(", ") || "—"} |`);
    }
    lines.push("");

    // Detailed invalid packs
    if (invalid.length > 0) {
      lines.push(`### Invalid Packs\n`);
      for (const r of invalid) {
        lines.push(`<details>\n<summary><b>${r.slug}</b> — ${r.displayName}</summary>\n`);
        lines.push(`**Errors:**`);
        for (const err of r.errors) lines.push(`- ${err}`);
        if (r.warnings.length > 0) {
          lines.push(`\n**Warnings:**`);
          for (const w of r.warnings) lines.push(`- ${w}`);
        }
        lines.push(`\n</details>\n`);
      }
    }

    // Status changes
    if (changed.length > 0) {
      lines.push(`### Status Changes\n`);
      for (const r of changed) {
        lines.push(`- **${r.slug}**: \`${r.previousStatus}\` → \`${r.newStatus}\``);
      }
      lines.push("");
    }

    // Warnings on valid packs
    if (withWarnings.length > 0) {
      lines.push(`### Warnings on Active Packs\n`);
      for (const r of withWarnings) {
        lines.push(`<details>\n<summary><b>${r.slug}</b></summary>\n`);
        for (const w of r.warnings) lines.push(`- ${w}`);
        lines.push(`\n</details>\n`);
      }
    }

    if (failures.length > 0) {
      lines.push(`### Not Validated\n`, "Stored verdicts were left unchanged for these packs.\n");
      for (const f of failures) lines.push(`- **${f.slug}**: ${f.message}`);
      lines.push("");
    }

    // Filed issues
    if (issueResults.length > 0) {
      lines.push(`### Filed Issues\n`);
      for (const ir of issueResults) {
        switch (ir.type) {
          case "filed":
            lines.push(`- **${ir.slug}**: [Issue filed](${ir.url})`);
            break;
          case "skipped":
            lines.push(`- **${ir.slug}**: Open issue already exists`);
            break;
          case "failed":
            lines.push(`- **${ir.slug}**: Failed to file issue`);
            break;
        }
      }
      lines.push("");
    }

    writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"), { flag: "a" });
  }

  for (const f of failures) console.log(`::warning::${f.slug} not validated: ${f.message}`);

  // A pack turning invalid is a routine outcome, announced by its issue; only failures of the run itself fail the job.
  const newlyInvalid = reports.filter((r) => r.statusChanged && r.newStatus === "invalid");
  if (newlyInvalid.length > 0) console.log(`\n${newlyInvalid.length} pack(s) newly marked invalid`);

  const controlPlaneFailures: string[] = [];
  if (aborted) controlPlaneFailures.push(`run aborted: ${aborted instanceof Error ? aborted.message : String(aborted)}`);
  if (writeFailures.length > 0) controlPlaneFailures.push(`status update failed for ${writeFailures.join(", ")}`);
  if (reports.length === 0 && failures.length > 0) controlPlaneFailures.push("no pack could be validated");
  if (controlPlaneFailures.length > 0) {
    for (const f of controlPlaneFailures) console.log(`::error::${f}`);
    process.exit(1);
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
