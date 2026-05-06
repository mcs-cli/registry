import type { Env, PackEntry } from "../types.js";
import {
  batchFetchRepoMetadata,
  fetchRepoMetadata,
  fetchTechpackYaml,
  parseGitHubUrl,
} from "../lib/github.js";
import { validateTechpackYaml } from "../lib/validator.js";
import { validatePackFiles } from "../lib/file-validation.js";

export interface ReindexResult {
  total: number;
  updated: number;
  unchanged: number;
  unavailable: number;
  invalid: number;
  removed: number;
  // Control-plane errors only (e.g. batch metadata fetch failed). Per-pack
  // validation failures are tracked via `invalid` and persisted to
  // `pack.validationErrors`; they must NOT be pushed here, or the workflow's
  // `error_count != 0` hard-fail trips on routine bad manifests.
  errors: string[];
}

export async function handleReindex(env: Env, options?: { force?: boolean }): Promise<ReindexResult> {
  const force = options?.force ?? false;
  const result: ReindexResult = {
    total: 0,
    updated: 0,
    unchanged: 0,
    unavailable: 0,
    invalid: 0,
    removed: 0,
    errors: [],
  };

  const indexRaw = await env.PACKS.get("index:all");
  if (!indexRaw) {
    console.log("[reindex] No index found — nothing to reindex");
    return result;
  }

  const slugs = JSON.parse(indexRaw) as string[];
  if (slugs.length === 0) {
    console.log("[reindex] Index is empty — nothing to reindex");
    return result;
  }

  result.total = slugs.length;
  console.log(`[reindex] Starting reindex of ${slugs.length} packs${force ? " (force revalidate)" : ""}`);

  // Collect all repo URLs
  const packMap = new Map<string, PackEntry>();
  const repoUrls: string[] = [];

  for (const slug of slugs) {
    const raw = await env.PACKS.get(`pack:${slug}`);
    if (!raw) {
      console.log(`[reindex] Pack "${slug}" not found in KV — skipping`);
      continue;
    }
    const pack = JSON.parse(raw) as PackEntry;
    packMap.set(slug, pack);
    repoUrls.push(pack.repoUrl);
  }

  // Abort before the prune step on any upstream failure: a partial/empty map
  // would otherwise be interpreted as "every repo is gone" — the cascade that
  // wiped index:all on 2026-05-05.
  console.log(
    `[reindex] Fetching metadata for ${repoUrls.length} repos via GraphQL`
  );
  let metadataMap;
  try {
    metadataMap = await batchFetchRepoMetadata(repoUrls, env.GITHUB_TOKEN);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reindex] Aborting — batch metadata fetch failed: ${msg}`);
    result.errors.push(`batch-metadata-fetch-failed: ${msg}`);
    return result;
  }
  console.log(
    `[reindex] Got metadata for ${metadataMap.size}/${repoUrls.length} repos`
  );

  for (const [slug, pack] of packMap) {
    const metadata = metadataMap.get(pack.repoUrl);

    if (!metadata) {
      // Repo not found or inaccessible
      if (pack.status !== "unavailable") {
        pack.status = "unavailable";
        pack.indexedAt = new Date().toISOString();
        await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
        console.log(`[reindex] "${slug}" → unavailable (repo not found)`);
      } else {
        console.log(`[reindex] "${slug}" → still unavailable`);
      }
      result.unavailable++;
      continue;
    }

    // Update star count and metadata regardless
    pack.stargazerCount = metadata.stargazerCount;
    pack.defaultBranch = metadata.defaultBranch;
    pack.latestTag = metadata.latestTag;

    // Only re-fetch techpack.yaml if the repo has been pushed to since last index
    const pushedAtChanged = pack.pushedAt !== metadata.pushedAt;
    pack.pushedAt = metadata.pushedAt;

    if (force || pushedAtChanged || pack.status !== "active") {
      // Re-fetch and re-validate techpack.yaml
      const parsed = parseGitHubUrl(pack.repoUrl);
      if (!parsed) {
        console.log(`[reindex] "${slug}" → error (invalid repo URL)`);
        continue;
      }

      const yamlContent = await fetchTechpackYaml(
        parsed.owner,
        parsed.repo,
        metadata.defaultBranch,
        env.GITHUB_TOKEN
      );

      if (!yamlContent) {
        pack.status = "invalid";
        pack.indexedAt = new Date().toISOString();
        await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
        console.log(`[reindex] "${slug}" → invalid (techpack.yaml not found)`);
        result.invalid++;
        continue;
      }

      const validation = validateTechpackYaml(yamlContent);
      if (!validation.valid || !validation.packData) {
        pack.status = "invalid";
        pack.validationErrors = validation.errors;
        pack.indexedAt = new Date().toISOString();
        await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
        console.log(`[reindex] "${slug}" → invalid: ${validation.errors.join("; ")}`);
        result.invalid++;
        continue;
      }

      // File-existence validation
      const fileValidation = await validatePackFiles(
        parsed.owner, parsed.repo, metadata.defaultBranch, env.GITHUB_TOKEN, validation.manifest
      );
      if (fileValidation?.errors.length) {
        pack.status = "invalid";
        pack.validationErrors = fileValidation.errors;
        pack.warnings = fileValidation.warnings.length > 0 ? fileValidation.warnings : undefined;
        pack.indexedAt = new Date().toISOString();
        await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
        console.log(`[reindex] "${slug}" → invalid: missing files: ${fileValidation.errors.join("; ")}`);
        result.invalid++;
        continue;
      }
      const fileWarnings = fileValidation?.warnings ?? [];

      // Update from fresh data
      pack.displayName = validation.packData.displayName;
      pack.description = validation.packData.description;
      pack.author = validation.packData.author;
      pack.components = validation.packData.components;
      pack.keywords = validation.packData.keywords;
      pack.warnings = fileWarnings.length > 0 ? fileWarnings : undefined;
      pack.validationErrors = undefined;
      pack.status = "active";
      console.log(`[reindex] "${slug}" → updated`);
      result.updated++;
    } else {
      console.log(`[reindex] "${slug}" → unchanged (no new push)`);
      result.unchanged++;
    }

    pack.indexedAt = new Date().toISOString();
    await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
  }

  // Remove unavailable packs from the index (invalid packs stay; preserve slugs missing from KV)
  const keptSlugs = slugs.filter((slug) => {
    const pack = packMap.get(slug);
    if (!pack) return true; // KV read may have failed — keep in index for next run
    return pack.status !== "unavailable";
  });

  if (keptSlugs.length !== slugs.length) {
    result.removed = slugs.length - keptSlugs.length;
    await env.PACKS.put("index:all", JSON.stringify(keptSlugs));
    console.log(`[reindex] Pruned ${result.removed} unavailable packs from index`);
  }

  console.log(
    `[reindex] Done — ${result.updated} updated, ${result.unchanged} unchanged, ${result.unavailable} unavailable, ${result.invalid} invalid, ${result.removed} removed, ${result.errors.length} errors`
  );
  return result;
}

export async function reindexSinglePack(
  slug: string,
  env: Env
): Promise<void> {
  const raw = await env.PACKS.get(`pack:${slug}`);
  if (!raw) return;

  const pack = JSON.parse(raw) as PackEntry;
  const metadata = await fetchRepoMetadata(pack.repoUrl, env.GITHUB_TOKEN);

  if (!metadata) {
    pack.status = "unavailable";
    pack.indexedAt = new Date().toISOString();
    await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
    return;
  }

  pack.stargazerCount = metadata.stargazerCount;
  pack.defaultBranch = metadata.defaultBranch;
  pack.latestTag = metadata.latestTag;
  pack.pushedAt = metadata.pushedAt;

  const parsed = parseGitHubUrl(pack.repoUrl);
  if (!parsed) return;

  const yamlContent = await fetchTechpackYaml(
    parsed.owner,
    parsed.repo,
    metadata.defaultBranch,
    env.GITHUB_TOKEN
  );

  if (!yamlContent) {
    pack.status = "invalid";
    pack.indexedAt = new Date().toISOString();
    await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
    return;
  }

  const validation = validateTechpackYaml(yamlContent);
  if (!validation.valid || !validation.packData) {
    pack.status = "invalid";
    pack.validationErrors = validation.errors;
    pack.indexedAt = new Date().toISOString();
    await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
    return;
  }

  // File-existence validation
  const fileValidation = await validatePackFiles(
    parsed.owner, parsed.repo, metadata.defaultBranch, env.GITHUB_TOKEN, validation.manifest
  );
  if (fileValidation?.errors.length) {
    pack.status = "invalid";
    pack.validationErrors = fileValidation.errors;
    pack.warnings = fileValidation.warnings.length > 0 ? fileValidation.warnings : undefined;
    pack.indexedAt = new Date().toISOString();
    await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
    return;
  }
  const fileWarnings = fileValidation?.warnings ?? [];

  pack.displayName = validation.packData.displayName;
  pack.description = validation.packData.description;
  pack.author = validation.packData.author;
  pack.components = validation.packData.components;
  pack.keywords = validation.packData.keywords;
  pack.warnings = fileWarnings.length > 0 ? fileWarnings : undefined;
  pack.validationErrors = undefined;
  pack.status = "active";
  pack.indexedAt = new Date().toISOString();

  await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
}
