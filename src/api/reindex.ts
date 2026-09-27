import type { Env, PackEntry, RepoMetadata } from "../types.js";
import { batchFetchRepoMetadata, fetchRepoMetadata } from "../lib/github.js";
import { reconcileIndex } from "../lib/packIndex.js";

// Reindex owns repository metadata and the `unavailable` status. Validity (`active` / `invalid`,
// `warnings`, `validationErrors`) is written by the scheduled validation (scripts/validate.ts) and
// by submit, so no two writers disagree about the same pack. The one exception: a pack that comes
// back from `unavailable` gets its last verdict restored here (see applyMetadata).

export interface ReindexResult {
  total: number;
  updated: number;
  unchanged: number;
  unavailable: number;
  // GitHub answered without saying whether the repository exists; the pack is left exactly as stored.
  skipped: number;
  removed: number;
  // Control-plane errors only (e.g. batch metadata fetch failed); the workflow hard-fails on any.
  errors: string[];
}

export async function handleReindex(env: Env): Promise<ReindexResult> {
  const result: ReindexResult = {
    total: 0,
    updated: 0,
    unchanged: 0,
    unavailable: 0,
    skipped: 0,
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
  console.log(`[reindex] Starting metadata reindex of ${slugs.length} packs`);

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
  let batch;
  try {
    batch = await batchFetchRepoMetadata(repoUrls, env.GITHUB_TOKEN);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reindex] Aborting — batch metadata fetch failed: ${msg}`);
    result.errors.push(`batch-metadata-fetch-failed: ${msg}`);
    return result;
  }
  console.log(
    `[reindex] Got metadata for ${batch.found.size}/${repoUrls.length} repos`
  );

  for (const [slug, pack] of packMap) {
    if (batch.unknown.has(pack.repoUrl)) {
      console.log(`[reindex] "${slug}" → skipped (GitHub did not say whether the repo exists)`);
      result.skipped++;
      continue;
    }

    const metadata = batch.found.get(pack.repoUrl);
    if (!metadata) {
      // GitHub reported the repository NOT_FOUND
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

    if (!applyMetadata(pack, metadata)) {
      // Skipping the write keeps KV writes proportional to change (free tier: 1,000/day).
      console.log(`[reindex] "${slug}" → unchanged`);
      result.unchanged++;
      continue;
    }
    console.log(`[reindex] "${slug}" → updated`);
    result.updated++;
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
    `[reindex] Done — ${result.updated} updated, ${result.unchanged} unchanged, ${result.unavailable} unavailable, ${result.skipped} skipped, ${result.removed} removed, ${result.errors.length} errors`
  );
  return result;
}

/**
 * Copies fresh repository metadata onto the pack and reports whether anything changed. A pack that
 * was unavailable and is reachable again shows its last verdict and loses its `deepValidatedAt`, so
 * the next scheduled validation re-checks it rather than trusting a verdict recorded before the
 * repository went away. Only reindexSinglePack can meet such a pack: the scheduled reindex walks
 * index:all, which never lists an unavailable pack.
 */
function applyMetadata(pack: PackEntry, metadata: RepoMetadata): boolean {
  const changed =
    pack.status === "unavailable" ||
    pack.stargazerCount !== metadata.stargazerCount ||
    pack.defaultBranch !== metadata.defaultBranch ||
    pack.latestTag !== metadata.latestTag ||
    pack.pushedAt !== metadata.pushedAt;

  pack.stargazerCount = metadata.stargazerCount;
  pack.defaultBranch = metadata.defaultBranch;
  pack.latestTag = metadata.latestTag;
  pack.pushedAt = metadata.pushedAt;

  if (pack.status === "unavailable") {
    pack.status = pack.validationErrors?.length ? "invalid" : "active";
    pack.deepValidatedAt = undefined;
  }
  return changed;
}

/**
 * Background refresh for a stale pack view; metadata only, like the scheduled reindex. Once GitHub
 * has been asked, the pack is always written back with a fresh `indexedAt`: that write is what
 * throttles handleGetPack to one refresh per pack per hour, since the scheduled reindex leaves
 * unchanged packs untouched.
 */
export async function reindexSinglePack(slug: string, env: Env): Promise<void> {
  const raw = await env.PACKS.get(`pack:${slug}`);
  if (!raw) return;
  const { repoUrl } = JSON.parse(raw) as PackEntry;

  // undefined: GitHub gave no answer about the repository, so only the throttle is recorded.
  let metadata: RepoMetadata | null | undefined;
  try {
    metadata = await fetchRepoMetadata(repoUrl, env.GITHUB_TOKEN);
  } catch (err) {
    console.error(`[reindex] Single refresh of "${slug}" got no answer: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Re-read after the GitHub round trip and change only repository fields, so a verdict written
  // meanwhile is kept. This narrows the race but cannot close it: KV reads can be up to ~60s stale.
  const freshRaw = await env.PACKS.get(`pack:${slug}`);
  if (!freshRaw) return;
  const pack = JSON.parse(freshRaw) as PackEntry;
  const previousStatus = pack.status;

  if (metadata) applyMetadata(pack, metadata);
  else if (metadata === null) pack.status = "unavailable";

  pack.indexedAt = new Date().toISOString();
  await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
  if (pack.status !== previousStatus) await reconcileIndex(env, pack);
}
