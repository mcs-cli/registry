import { fetchRepoTree } from "./github.js";
import { validateFileReferences } from "./validator.js";

export interface FileValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Fetches the repo tree and validates file references from the manifest.
 * Returns null if the tree cannot be fetched or manifest is unavailable (graceful degradation).
 */
export async function validatePackFiles(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  manifest?: Record<string, unknown>
): Promise<FileValidationResult | null> {
  if (!manifest) return null;

  const repoTree = await fetchRepoTree(owner, repo, branch, token);
  if (!repoTree) {
    console.log(`[file-validation] Skipped for ${owner}/${repo}: tree fetch failed`);
    return null;
  }

  return validateFileReferences(manifest, repoTree);
}
