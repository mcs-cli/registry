import type { ExtractedPackData, RepoTree } from "../types.js";
import { runHeuristics, validateFileReferences, validateTechpackYaml } from "./validator.js";

export interface PackEvaluation {
  status: "active" | "invalid";
  errors: string[];
  warnings: string[];
  packData?: ExtractedPackData;
}

export const TREE_UNAVAILABLE_WARNING =
  "Repository tree is too large to enumerate — file checks were skipped";

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

  const missing = tree ? validateFileReferences(validation.manifest, tree) : [];
  if (missing.length > 0) {
    return { ...invalid(missing), packData: validation.packData };
  }

  const findings = runHeuristics(validation.manifest, tree);
  const errors = findings.filter((f) => f.severity === "error").map((f) => f.message);
  const warnings = findings.filter((f) => f.severity === "warning").map((f) => f.message);
  if (!tree) warnings.unshift(TREE_UNAVAILABLE_WARNING);

  return {
    status: errors.length > 0 ? "invalid" : "active",
    errors,
    warnings,
    packData: validation.packData,
  };
}

function invalid(errors: string[]): PackEvaluation {
  return { status: "invalid", errors, warnings: [] };
}
