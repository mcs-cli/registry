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
import type { RepoTree } from "../src/types.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const REGISTRY_URL = process.env.REGISTRY_URL ?? "https://techpacks.mcs-cli.dev";
const REINDEX_SECRET = process.env.REINDEX_SECRET ?? "";
const REGISTRY_REPO = "mcs-cli/registry";

if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
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
  warnings?: string[];
  validationErrors?: string[];
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

async function fetchDefaultBranch(owner: string, repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: GH_HEADERS });
  if (!res.ok) return null;
  const data = (await res.json()) as { default_branch: string };
  return data.default_branch;
}

async function fetchTechpackYaml(owner: string, repo: string, branch: string): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/techpack.yaml?ref=${branch}`,
    { headers: { ...GH_HEADERS, Accept: "application/vnd.github.v3.raw" } }
  );
  if (!res.ok) return null;
  return res.text();
}

async function fetchRepoTree(owner: string, repo: string, branch: string): Promise<RepoTree | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: GH_HEADERS }
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { tree: Array<{ path: string; type: string }>; truncated: boolean };
  if (json.truncated) return null;
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
  for (const dir of wellKnownDirs) {
    if (!tree.directories.has(dir)) continue;
    for (const file of tree.files) {
      if (!file.startsWith(`${dir}/`)) continue;
      // Check if this file or its parent directory is referenced
      const isReferenced = referencedPaths.has(file) ||
        [...referencedPaths].some((p) => file.startsWith(`${p}/`));
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

// -- Registry API --

async function fetchAllPacks(): Promise<PackInfo[]> {
  const res = await fetch(`${REGISTRY_URL}/api/packs?include=all&limit=500`);
  if (!res.ok) throw new Error(`Registry API returned HTTP ${res.status}`);
  const data = (await res.json()) as { packs: PackInfo[] };
  return data.packs;
}

async function updatePackStatus(
  slug: string,
  status: "active" | "invalid",
  warnings: string[],
  validationErrors: string[]
): Promise<boolean> {
  if (!REINDEX_SECRET) {
    console.log(`  [dry-run] Would update ${slug} → ${status}`);
    return true;
  }
  const res = await fetch(`${REGISTRY_URL}/api/packs/update-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${REINDEX_SECRET}`,
    },
    body: JSON.stringify({ slug, status, warnings, validationErrors }),
  });
  return res.ok;
}

// -- Issue filing (on the registry repo) --

const ISSUE_TAG = "[Validation]";
const ISSUE_HEADERS: Record<string, string> = {
  ...GH_HEADERS,
  "Content-Type": "application/json",
};

async function hasOpenIssue(slug: string): Promise<boolean> {
  const query = encodeURIComponent(`repo:${REGISTRY_REPO} is:issue is:open "${ISSUE_TAG} ${slug}" in:title`);
  const res = await fetch(`https://api.github.com/search/issues?q=${query}&per_page=1`, {
    headers: ISSUE_HEADERS,
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { total_count: number };
  return data.total_count > 0;
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

  const res = await fetch(`https://api.github.com/repos/${REGISTRY_REPO}/issues`, {
    method: "POST",
    headers: ISSUE_HEADERS,
    body: JSON.stringify({
      title: `${ISSUE_TAG} ${report.slug} — validation failed`,
      body,
      labels: ["validation"],
    }),
  });

  if (!res.ok) {
    // Label might not exist yet — retry without labels
    if (res.status === 422) {
      const retry = await fetch(`https://api.github.com/repos/${REGISTRY_REPO}/issues`, {
        method: "POST",
        headers: ISSUE_HEADERS,
        body: JSON.stringify({
          title: `${ISSUE_TAG} ${report.slug} — validation failed`,
          body,
        }),
      });
      if (!retry.ok) return null;
      const retryData = (await retry.json()) as { html_url: string };
      return retryData.html_url;
    }
    return null;
  }
  const data = (await res.json()) as { html_url: string };
  return data.html_url;
}

interface IssueResult {
  slug: string;
  url?: string;
  skipped?: boolean;
  failed?: boolean;
}

async function fileIssuesForNewlyInvalid(reports: ValidationReport[], packs: PackInfo[]): Promise<IssueResult[]> {
  const results: IssueResult[] = [];
  const newlyInvalid = reports.filter((r) => r.statusChanged && r.newStatus === "invalid");
  if (newlyInvalid.length === 0) return results;

  console.log(`\nFiling issues for ${newlyInvalid.length} newly invalid pack(s)...`);

  for (const report of newlyInvalid) {
    const pack = packs.find((p) => p.slug === report.slug);
    if (!pack) continue;

    // Check for existing open issue first
    const existing = await hasOpenIssue(report.slug);
    if (existing) {
      console.log(`  ${report.slug} — open issue already exists, skipping`);
      results.push({ slug: report.slug, skipped: true });
      continue;
    }

    const issueUrl = await fileIssue(report, pack.repoUrl);
    if (issueUrl) {
      console.log(`  ${report.slug} — issue filed: ${issueUrl}`);
      results.push({ slug: report.slug, url: issueUrl });
    } else {
      console.log(`  ${report.slug} — failed to file issue`);
      results.push({ slug: report.slug, failed: true });
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

  const match = pack.repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    report.errors.push("Invalid repo URL");
    report.newStatus = "invalid";
    return report;
  }
  const [, owner, repo] = match;

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

  for (const pack of packs) {
    process.stdout.write(`  ${pack.slug} ... `);
    const report = await validatePack(pack);
    reports.push(report);

    const icon = report.newStatus === "active" ? "✅" : "❌";
    const extras: string[] = [];
    if (report.warnings.length > 0) extras.push(`${report.warnings.length} warnings`);
    if (report.heuristics.length > 0) extras.push(`${report.heuristics.length} hints`);
    console.log(`${icon} ${report.newStatus}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`);

    // Update status if changed
    const statusChanged = report.newStatus !== pack.status;
    const warningsChanged = JSON.stringify(report.warnings) !== JSON.stringify(pack.warnings ?? []);
    const errorsChanged = JSON.stringify(report.errors) !== JSON.stringify(pack.validationErrors ?? []);

    if (statusChanged || warningsChanged || errorsChanged) {
      report.statusChanged = true;
      // Merge heuristic hints into warnings for storage
      const allWarnings = [...report.warnings, ...report.heuristics];
      const updated = await updatePackStatus(report.slug, report.newStatus, allWarnings, report.errors);
      if (!updated) {
        console.log(`    ⚠️  Failed to update status for ${report.slug}`);
      }
    }
  }

  // Summary
  const valid = reports.filter((r) => r.newStatus === "active");
  const invalid = reports.filter((r) => r.newStatus === "invalid");
  const changed = reports.filter((r) => r.statusChanged);
  const withWarnings = reports.filter((r) => r.warnings.length > 0 && r.newStatus === "active");
  const withHeuristics = reports.filter((r) => r.heuristics.length > 0);

  console.log("\n=== Summary ===\n");
  console.log(`  Total:           ${reports.length}`);
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
    let summary = `## Deep Validation Report\n\n`;

    // Overview table
    summary += `| Metric | Count |\n|--------|-------|\n`;
    summary += `| Total packs | ${reports.length} |\n`;
    summary += `| Active | ${valid.length} |\n`;
    summary += `| Invalid | ${invalid.length} |\n`;
    summary += `| Status changed | ${changed.length} |\n`;
    summary += `| With warnings | ${withWarnings.length} |\n`;
    summary += `| With hints | ${withHeuristics.length} |\n\n`;

    // Per-pack results table
    summary += `### Pack Results\n\n`;
    summary += `| Pack | Status | Issues |\n|------|--------|--------|\n`;
    for (const r of reports) {
      const icon = r.newStatus === "active" ? "pass" : "FAIL";
      const change = r.statusChanged ? ` (was ${r.previousStatus})` : "";
      const issues: string[] = [];
      if (r.errors.length > 0) issues.push(`${r.errors.length} error(s)`);
      if (r.warnings.length > 0) issues.push(`${r.warnings.length} warning(s)`);
      if (r.heuristics.length > 0) issues.push(`${r.heuristics.length} hint(s)`);
      summary += `| \`${r.slug}\` | ${icon}${change} | ${issues.join(", ") || "—"} |\n`;
    }
    summary += `\n`;

    // Detailed invalid packs
    if (invalid.length > 0) {
      summary += `### Invalid Packs\n\n`;
      for (const r of invalid) {
        summary += `<details>\n<summary><b>${r.slug}</b> — ${r.displayName}</summary>\n\n`;
        summary += `**Errors:**\n`;
        for (const err of r.errors) summary += `- ${err}\n`;
        if (r.warnings.length > 0) {
          summary += `\n**Warnings:**\n`;
          for (const w of r.warnings) summary += `- ${w}\n`;
        }
        if (r.heuristics.length > 0) {
          summary += `\n**Hints:**\n`;
          for (const h of r.heuristics) summary += `- ${h}\n`;
        }
        summary += `\n</details>\n\n`;
      }
    }

    // Status changes
    if (changed.length > 0) {
      summary += `### Status Changes\n\n`;
      for (const r of changed) {
        summary += `- **${r.slug}**: \`${r.previousStatus}\` → \`${r.newStatus}\`\n`;
      }
      summary += `\n`;
    }

    // Warnings on valid packs
    if (withWarnings.length > 0) {
      summary += `### Warnings on Active Packs\n\n`;
      for (const r of withWarnings) {
        summary += `<details>\n<summary><b>${r.slug}</b></summary>\n\n`;
        for (const w of r.warnings) summary += `- ${w}\n`;
        summary += `\n</details>\n\n`;
      }
    }

    // Heuristic hints
    if (withHeuristics.length > 0) {
      summary += `### Heuristic Hints\n\n`;
      for (const r of withHeuristics) {
        summary += `<details>\n<summary><b>${r.slug}</b> (${r.heuristics.length} hint${r.heuristics.length > 1 ? "s" : ""})</summary>\n\n`;
        for (const h of r.heuristics) summary += `- ${h}\n`;
        summary += `\n</details>\n\n`;
      }
    }

    // Filed issues
    if (issueResults.length > 0) {
      summary += `### Filed Issues\n\n`;
      for (const ir of issueResults) {
        if (ir.url) {
          summary += `- **${ir.slug}**: [Issue filed](${ir.url})\n`;
        } else if (ir.skipped) {
          summary += `- **${ir.slug}**: Open issue already exists\n`;
        } else if (ir.failed) {
          summary += `- **${ir.slug}**: Failed to file issue\n`;
        }
      }
      summary += `\n`;
    }

    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
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
