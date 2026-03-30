/**
 * Deep validation of all registered tech packs.
 * Runs as a GitHub Actions workflow (daily + manual trigger).
 *
 * Usage: npx tsx scripts/validate.ts
 *
 * Required env vars:
 *   GITHUB_TOKEN          — GitHub token for API access and issue filing (provided by Actions)
 *   REGISTRY_URL          — Registry API base URL (e.g., https://techpacks.mcs-cli.dev)
 *   REINDEX_SECRET        — Auth token for the update-status endpoint
 */
import { validateTechpackYaml, validateFileReferences } from "../src/lib/validator.js";
import { parseGitHubUrl } from "../src/lib/github.js";
import type { RepoTree } from "../src/types.js";

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
  pushedAt: string;
  warnings?: string[];
  validationErrors?: string[];
  deepValidatedAt?: string;
}

interface ValidationReport {
  slug: string;
  displayName: string;
  previousStatus: string;
  newStatus: "active" | "invalid";
  errors: string[];
  warnings: string[];
  heuristics: string[];
  statusChanged: boolean;
}

// -- GitHub API --

class RateLimitError extends Error {
  constructor(status: number, endpoint: string) {
    super(`GitHub API rate limited (HTTP ${status}) at ${endpoint}`);
  }
}

function checkRateLimit(res: Response, endpoint: string): void {
  if (res.status === 403 || res.status === 429) {
    throw new RateLimitError(res.status, endpoint);
  }
}

async function fetchDefaultBranch(owner: string, repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: GH_HEADERS });
  if (!res.ok) {
    checkRateLimit(res, `repos/${owner}/${repo}`);
    return null;
  }
  const data = (await res.json()) as { default_branch: string };
  return data.default_branch;
}

async function fetchTechpackYaml(owner: string, repo: string, branch: string): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/techpack.yaml?ref=${branch}`,
    { headers: { ...GH_HEADERS, Accept: "application/vnd.github.v3.raw" } }
  );
  if (!res.ok) {
    checkRateLimit(res, `repos/${owner}/${repo}/contents`);
    return null;
  }
  return res.text();
}

async function fetchRepoTree(owner: string, repo: string, branch: string): Promise<RepoTree | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: GH_HEADERS }
  );
  if (!res.ok) {
    checkRateLimit(res, `repos/${owner}/${repo}/git/trees`);
    return null;
  }
  const json = (await res.json()) as { tree: Array<{ path: string; type: string }>; truncated: boolean };
  if (json.truncated) {
    console.warn(`  Tree truncated for ${owner}/${repo} — repo too large for full enumeration`);
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

// -- Heuristic checks (Actions-only, too expensive for Worker) --

function runHeuristics(
  manifest: Record<string, unknown>,
  tree: RepoTree
): string[] {
  const hints: string[] = [];

  const components = (manifest.components ?? []) as Array<Record<string, unknown>>;

  // Collect all referenced source paths
  const referencedPaths = new Set<string>();
  for (const comp of components) {
    for (const key of ["hook", "command", "skill", "agent"] as const) {
      const shorthand = comp[key] as Record<string, unknown> | undefined;
      if (shorthand?.source && typeof shorthand.source === "string") {
        referencedPaths.add(shorthand.source.replace(/^\.\//, "").trim());
      }
    }
    if (typeof comp.settingsFile === "string") {
      referencedPaths.add(comp.settingsFile.replace(/^\.\//, "").trim());
    }
    const action = comp.installAction as Record<string, unknown> | undefined;
    if (action?.source && typeof action.source === "string") {
      referencedPaths.add(action.source.replace(/^\.\//, "").trim());
    }
  }

  const templates = (manifest.templates ?? []) as Array<Record<string, unknown>>;
  for (const t of templates) {
    if (typeof t.contentFile === "string") {
      referencedPaths.add(t.contentFile.replace(/^\.\//, "").trim());
    }
  }

  // Heuristic 1: Files in well-known directories that are not referenced
  const wellKnownDirs = ["hooks", "skills", "commands", "agents", "templates"];
  const referencedPathsArray = [...referencedPaths];
  for (const dir of wellKnownDirs) {
    if (!tree.directories.has(dir)) continue;
    for (const file of tree.files) {
      if (!file.startsWith(`${dir}/`)) continue;
      const isReferenced = referencedPaths.has(file) ||
        referencedPathsArray.some((p) => file.startsWith(`${p}/`));
      if (!isReferenced) {
        hints.push(`Unreferenced file '${file}' in ${dir}/ directory — may be unwired content`);
      }
    }
  }

  // Heuristic 2: MCP server uses python/node but no matching brew package
  const mcpComponents = components.filter((c) => {
    const type = c.type as string | undefined;
    return type === "mcpServer" || c.mcp !== undefined;
  });
  const brewIds = new Set(
    components
      .filter((c) => c.type === "brewPackage" || c.brew !== undefined)
      .map((c) => c.id as string)
  );

  for (const mcp of mcpComponents) {
    const mcpConfig = mcp.mcp as Record<string, unknown> | undefined;
    const command = mcpConfig?.command as string | undefined;
    if (!command) continue;

    if ((command === "python" || command === "python3") && !brewIds.has("python") && !brewIds.has("python3")) {
      hints.push(`MCP server '${mcp.id}' uses '${command}' but no python brew package is declared`);
    }
    if ((command === "node" || command === "npx") && !brewIds.has("node")) {
      hints.push(`MCP server '${mcp.id}' uses '${command}' but no node brew package is declared`);
    }
  }

  return hints;
}

// -- Skip logic --

const FORCE_ALL = process.env.FORCE_ALL === "true";

function canSkipValidation(pack: PackInfo): boolean {
  if (FORCE_ALL) return false;
  // Always validate packs with existing warnings or errors
  if ((pack.warnings?.length ?? 0) > 0) return false;
  if ((pack.validationErrors?.length ?? 0) > 0) return false;
  // Always validate non-active packs (might have been fixed)
  if (pack.status !== "active") return false;
  // Skip if pack hasn't been pushed since last deep validation
  if (!pack.deepValidatedAt || !pack.pushedAt) return false;
  return new Date(pack.pushedAt).getTime() <= new Date(pack.deepValidatedAt).getTime();
}

// -- Registry API --

async function fetchAllPacks(): Promise<PackInfo[]> {
  const res = await fetch(`${REGISTRY_URL}/api/packs?include=all&limit=500`);
  if (!res.ok) throw new Error(`Registry API returned HTTP ${res.status}`);
  const data = (await res.json()) as { packs: PackInfo[] };
  return data.packs;
}

interface UpdateStatusPayload {
  slug: string;
  status: "active" | "invalid";
  warnings: string[];
  validationErrors: string[];
  deepValidatedAt: string;
}

async function updatePackStatus(payload: UpdateStatusPayload): Promise<boolean> {
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
  const hintList = report.heuristics.length > 0
    ? `\n### Hints\n\n${report.heuristics.map((h) => `- ${h}`).join("\n")}\n`
    : "";

  const body = `## Validation failed for ${report.displayName}

**Pack:** \`${report.slug}\`
**Repo:** ${repoUrl}
**Previous status:** ${report.previousStatus}

### Errors

${errorList}
${warningList}${hintList}
### How to fix

1. Check that all file paths in \`techpack.yaml\` point to files that actually exist in the repository
2. Ensure the pack has at least one component or template
3. Push the fix to the default branch — the registry will automatically re-validate on the next cycle

Once the issues are resolved, this pack will be restored to **active** status and this issue can be closed.

---
*Filed automatically by the [deep validation workflow](https://github.com/${REGISTRY_REPO}/actions/workflows/validate.yml)*`;

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
  const report: ValidationReport = {
    slug: pack.slug,
    displayName: pack.displayName,
    previousStatus: pack.status,
    newStatus: "active",
    errors: [],
    warnings: [],
    heuristics: [],
    statusChanged: false,
  };

  const parsed = parseGitHubUrl(pack.repoUrl);
  if (!parsed) {
    report.errors.push("Invalid repo URL");
    report.newStatus = "invalid";
    return report;
  }
  const { owner, repo } = parsed;

  // Fetch default branch
  const branch = await fetchDefaultBranch(owner, repo);
  if (!branch) {
    report.errors.push("Repository not found or not accessible");
    report.newStatus = "invalid";
    return report;
  }

  // Fetch techpack.yaml
  const yaml = await fetchTechpackYaml(owner, repo, branch);
  if (!yaml) {
    report.errors.push("No techpack.yaml found at repository root");
    report.newStatus = "invalid";
    return report;
  }

  // Structural validation
  const validation = validateTechpackYaml(yaml);
  if (!validation.valid || !validation.packData) {
    report.errors.push(...validation.errors);
    report.newStatus = "invalid";
    return report;
  }

  // Fetch tree
  const tree = await fetchRepoTree(owner, repo, branch);
  if (!tree) {
    report.warnings.push("Could not fetch repository tree — file validation skipped");
    return report;
  }

  // File-existence validation
  if (validation.manifest) {
    const fileValidation = validateFileReferences(validation.manifest, tree);
    report.errors.push(...fileValidation.errors);
    report.warnings.push(...fileValidation.warnings);
  }

  // Heuristic checks (Actions-only)
  if (validation.manifest) {
    report.heuristics.push(...runHeuristics(validation.manifest, tree));
  }

  if (report.errors.length > 0) {
    report.newStatus = "invalid";
  }

  return report;
}

async function main() {
  console.log("=== MCS Registry Deep Validation ===\n");

  // Fetch all packs (including inactive)
  const packs = await fetchAllPacks();
  console.log(`Found ${packs.length} packs to validate\n`);

  const reports: ValidationReport[] = [];

  let skippedCount = 0;

  for (const pack of packs) {
    process.stdout.write(`  ${pack.slug} ... `);

    if (canSkipValidation(pack)) {
      console.log(`⏭️  SKIPPED (unchanged, no warnings)`);
      skippedCount++;
      continue;
    }

    let report: ValidationReport;
    try {
      report = await validatePack(pack);
    } catch (err) {
      // Rate limit errors abort the entire run to prevent mass-invalidation
      if (err instanceof RateLimitError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`CRASH: ${message}`);
      report = {
        slug: pack.slug,
        displayName: pack.displayName,
        previousStatus: pack.status,
        newStatus: "invalid",
        errors: [`Validation crashed: ${message}`],
        warnings: [],
        heuristics: [],
        statusChanged: false,
      };
    }
    reports.push(report);

    const icon = report.newStatus === "active" ? "✅" : "❌";
    const extras: string[] = [];
    if (report.warnings.length > 0) extras.push(`${report.warnings.length} warnings`);
    if (report.heuristics.length > 0) extras.push(`${report.heuristics.length} hints`);
    console.log(`${icon} ${report.newStatus}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`);

    // Detect actual status transition vs. data-only drift
    report.statusChanged = report.newStatus !== pack.status;
    const warningsChanged = JSON.stringify(report.warnings) !== JSON.stringify(pack.warnings ?? []);
    const errorsChanged = JSON.stringify(report.errors) !== JSON.stringify(pack.validationErrors ?? []);

    // Always update to record deepValidatedAt (and any data changes)
    const now = new Date().toISOString();
    const allWarnings = [...report.warnings, ...report.heuristics];
    const updated = await updatePackStatus({
      slug: report.slug,
      status: report.newStatus,
      warnings: allWarnings,
      validationErrors: report.errors,
      deepValidatedAt: now,
    });
    if (!updated) {
      console.log(`    ⚠️  Failed to update status for ${report.slug}`);
    }
  }

  // Summary
  const valid = reports.filter((r) => r.newStatus === "active");
  const invalid = reports.filter((r) => r.newStatus === "invalid");
  const changed = reports.filter((r) => r.statusChanged);
  const withWarnings = reports.filter((r) => r.warnings.length > 0 && r.newStatus === "active");
  const withHeuristics = reports.filter((r) => r.heuristics.length > 0);

  console.log("\n=== Summary ===\n");
  console.log(`  Total:           ${packs.length}`);
  console.log(`  Skipped:         ${skippedCount}`);
  console.log(`  Validated:       ${reports.length}`);
  console.log(`  Valid:           ${valid.length}`);
  console.log(`  Invalid:         ${invalid.length}`);
  console.log(`  Status changed:  ${changed.length}`);
  console.log(`  With warnings:   ${withWarnings.length}`);
  console.log(`  With hints:      ${withHeuristics.length}`);

  // File issues for newly invalid packs (before step summary so we can include links)
  const issueResults = await fileIssuesForNewlyInvalid(reports, packs);

  // GitHub Actions step summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { writeFileSync } = await import("fs");
    const lines: string[] = [];

    // Overview table
    lines.push(
      `## Deep Validation Report\n`,
      `| Metric | Count |\n|--------|-------|`,
      `| Total packs | ${packs.length} |`,
      `| Skipped (unchanged) | ${skippedCount} |`,
      `| Validated | ${reports.length} |`,
      `| Active | ${valid.length} |`,
      `| Invalid | ${invalid.length} |`,
      `| Status changed | ${changed.length} |`,
      `| With warnings | ${withWarnings.length} |`,
      `| With hints | ${withHeuristics.length} |\n`,
    );

    // Per-pack results table
    lines.push(`### Pack Results\n`, `| Pack | Status | Issues |\n|------|--------|--------|`);
    for (const r of reports) {
      const icon = r.newStatus === "active" ? "pass" : "FAIL";
      const change = r.statusChanged ? ` (was ${r.previousStatus})` : "";
      const issues: string[] = [];
      if (r.errors.length > 0) issues.push(`${r.errors.length} error(s)`);
      if (r.warnings.length > 0) issues.push(`${r.warnings.length} warning(s)`);
      if (r.heuristics.length > 0) issues.push(`${r.heuristics.length} hint(s)`);
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
        if (r.heuristics.length > 0) {
          lines.push(`\n**Hints:**`);
          for (const h of r.heuristics) lines.push(`- ${h}`);
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

    // Heuristic hints
    if (withHeuristics.length > 0) {
      lines.push(`### Heuristic Hints\n`);
      for (const r of withHeuristics) {
        lines.push(`<details>\n<summary><b>${r.slug}</b> (${r.heuristics.length} hint${r.heuristics.length > 1 ? "s" : ""})</summary>\n`);
        for (const h of r.heuristics) lines.push(`- ${h}`);
        lines.push(`\n</details>\n`);
      }
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

  // Exit with error if any status transitions to invalid
  const newlyInvalid = reports.filter((r) => r.statusChanged && r.newStatus === "invalid");
  if (newlyInvalid.length > 0) {
    console.log(`\n${newlyInvalid.length} pack(s) newly marked invalid`);
    process.exit(1);
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
