import type { ExtractedPackData, RepoTree } from "../types.js";
import { fetchRepoTree, fetchTechpackYaml } from "./github.js";
import { runHeuristics, validateFileReferences, validateTechpackYaml } from "./validator.js";

export interface PackEvaluation {
  status: "active" | "invalid";
  errors: string[];
  warnings: string[];
  packData?: ExtractedPackData;
}

export const TREE_UNAVAILABLE_WARNING =
  "Repository tree is too large to enumerate — file checks and heuristics were skipped";

/**
 * The one verdict every registry path (submit, scheduled validation) records for a pack.
 * Follows `mcs pack validate`: a load failure stops before any heuristic, and the pack is
 * invalid exactly when mcs would exit non-zero.
 *
 * `tree` is null only when GitHub truncated it; a failed fetch must never reach here, or a
 * transient outage would be recorded as a verdict.
 */
export function evaluatePack(yamlContent: string | null, tree: RepoTree | null): PackEvaluation {
  if (yamlContent === null) {
    return invalid(["No techpack.yaml found at the repository root"]);
  }

  const validation = validateTechpackYaml(yamlContent);
  if (!validation.valid || !validation.packData || !validation.manifest) {
    return invalid(validation.errors);
  }
  const { packData, manifest } = validation;

  // mcs always has the checkout, so there is no mcs behavior to mirror for a missing tree.
  if (!tree) {
    return { status: "active", errors: [], warnings: [TREE_UNAVAILABLE_WARNING], packData };
  }

  const missing = validateFileReferences(manifest, tree);
  if (missing.length > 0) {
    return { ...invalid(missing), packData };
  }

  const findings = runHeuristics(manifest, tree);
  const errors = findings.filter((f) => f.severity === "error").map((f) => f.message);
  return {
    status: errors.length > 0 ? "invalid" : "active",
    errors,
    warnings: findings.filter((f) => f.severity === "warning").map((f) => f.message),
    packData,
  };
}

/** Fetches a repository's manifest and tree at `branch` and evaluates them; GitHub failures throw. */
export async function evaluateRepo(owner: string, repo: string, branch: string, token: string): Promise<PackEvaluation> {
  const [yamlContent, tree] = await Promise.all([
    fetchTechpackYaml(owner, repo, branch, token),
    fetchRepoTree(owner, repo, branch, token),
  ]);
  return evaluatePack(yamlContent, tree);
}

function invalid(errors: string[]): PackEvaluation {
  return { status: "invalid", errors, warnings: [] };
}
