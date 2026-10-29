import type { ExtractedPackData, RepoTree } from "../types.js";
import { fetchRepoFile, fetchRepoTree, fetchTechpackYaml } from "./github.js";
import {
  hostedPluginNames,
  PACK_MARKETPLACE_MANIFEST,
  reservedMarketplaceError,
  resolveHostedPlugins,
} from "./packMarketplace.js";
import { declaredPluginNames, runHeuristics, validateFileReferences, validateTechpackYaml } from "./validator.js";

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
 * transient outage would be recorded as a verdict. `marketplaceJson` is the pack's
 * `.claude-plugin/marketplace.json`, null when it has none; `evaluateRepo` is what decides whether
 * to fetch it, so passing null for a pack with `name@pack` plugins reports it missing.
 */
export function evaluatePack(
  yamlContent: string | null,
  tree: RepoTree | null,
  marketplaceJson: string | null
): PackEvaluation {
  const loaded = loadManifest(yamlContent);
  return "verdict" in loaded ? loaded.verdict : evaluateLoaded(loaded, tree, marketplaceJson);
}

/** Fetches a repository's manifest and tree at `branch` and evaluates them; GitHub failures throw. */
export async function evaluateRepo(owner: string, repo: string, branch: string, token: string): Promise<PackEvaluation> {
  const [yamlContent, tree] = await Promise.all([
    fetchTechpackYaml(owner, repo, branch, token),
    fetchRepoTree(owner, repo, branch, token),
  ]);
  const loaded = loadManifest(yamlContent);
  if ("verdict" in loaded) return loaded.verdict;
  const marketplaceJson = tree?.files.has(PACK_MARKETPLACE_MANIFEST) && hostedPluginNames(loaded.plugins).length > 0
    ? await fetchRepoFile(owner, repo, branch, PACK_MARKETPLACE_MANIFEST, token)
    : null;
  return evaluateLoaded(loaded, tree, marketplaceJson);
}

interface LoadedManifest {
  manifest: Record<string, unknown>;
  packData: ExtractedPackData;
  plugins: string[];
}

// The checks mcs runs before it reads anything but the manifest.
function loadManifest(yamlContent: string | null): LoadedManifest | { verdict: PackEvaluation } {
  if (yamlContent === null) {
    return { verdict: invalid(["No techpack.yaml found at the repository root"]) };
  }

  const validation = validateTechpackYaml(yamlContent);
  if (!validation.valid || !validation.packData || !validation.manifest) {
    return { verdict: invalid(validation.errors) };
  }
  const { packData, manifest } = validation;

  const plugins = declaredPluginNames(manifest);
  const reserved = reservedMarketplaceError(plugins);
  if (reserved) {
    return { verdict: { ...invalid([reserved]), packData } };
  }
  return { manifest, packData, plugins };
}

function evaluateLoaded(
  { manifest, packData, plugins }: LoadedManifest,
  tree: RepoTree | null,
  marketplaceJson: string | null
): PackEvaluation {
  // mcs always has the checkout, so there is no mcs behavior to mirror for a missing tree.
  if (!tree) {
    return { status: "active", errors: [], warnings: [TREE_UNAVAILABLE_WARNING], packData };
  }

  const pluginDirs = resolveHostedPlugins(plugins, marketplaceJson, tree);
  if (typeof pluginDirs === "string") {
    return { ...invalid([pluginDirs]), packData };
  }

  const missing = validateFileReferences(manifest, tree);
  if (missing.length > 0) {
    return { ...invalid(missing), packData };
  }

  const findings = runHeuristics(manifest, tree, pluginDirs);
  const errors = findings.filter((f) => f.severity === "error").map((f) => f.message);
  return {
    status: errors.length > 0 ? "invalid" : "active",
    errors,
    warnings: findings.filter((f) => f.severity === "warning").map((f) => f.message),
    packData,
  };
}

function invalid(errors: string[]): PackEvaluation {
  return { status: "invalid", errors, warnings: [] };
}
