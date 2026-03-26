import type { Env, PackEntry } from "../types.js";
import {
  batchFetchRepoMetadata,
  fetchRepoMetadata,
  fetchTechpackYaml,
  parseGitHubUrl,
} from "../lib/github.js";
import { validateTechpackYaml } from "../lib/validator.js";

export async function handleReindex(env: Env): Promise<void> {
  const indexRaw = await env.PACKS.get("index:all");
  if (!indexRaw) return;

  const identifiers = JSON.parse(indexRaw) as string[];
  if (identifiers.length === 0) return;

  // Collect all repo URLs
  const packMap = new Map<string, PackEntry>();
  const repoUrls: string[] = [];

  for (const id of identifiers) {
    const raw = await env.PACKS.get(`pack:${id}`);
    if (!raw) continue;
    const pack = JSON.parse(raw) as PackEntry;
    packMap.set(id, pack);
    repoUrls.push(pack.repoUrl);
  }

  // Batch fetch metadata via GraphQL
  const metadataMap = await batchFetchRepoMetadata(repoUrls, env.GITHUB_TOKEN);

  for (const [id, pack] of packMap) {
    const metadata = metadataMap.get(pack.repoUrl);

    if (!metadata) {
      // Repo not found or inaccessible
      if (pack.status !== "unavailable") {
        pack.status = "unavailable";
        pack.indexedAt = new Date().toISOString();
        await env.PACKS.put(`pack:${id}`, JSON.stringify(pack));
      }
      continue;
    }

    // Update star count and metadata regardless
    pack.stargazerCount = metadata.stargazerCount;
    pack.defaultBranch = metadata.defaultBranch;
    pack.latestTag = metadata.latestTag;

    // Only re-fetch techpack.yaml if the repo has been pushed to since last index
    const pushedAtChanged = pack.pushedAt !== metadata.pushedAt;
    pack.pushedAt = metadata.pushedAt;

    if (pushedAtChanged || pack.status !== "active") {
      // Re-fetch and re-validate techpack.yaml
      const parsed = parseGitHubUrl(pack.repoUrl);
      if (!parsed) continue;

      const yamlContent = await fetchTechpackYaml(
        parsed.owner,
        parsed.repo,
        metadata.defaultBranch,
        env.GITHUB_TOKEN
      );

      if (!yamlContent) {
        pack.status = "invalid";
        pack.indexedAt = new Date().toISOString();
        await env.PACKS.put(`pack:${id}`, JSON.stringify(pack));
        continue;
      }

      const validation = validateTechpackYaml(yamlContent);
      if (!validation.valid || !validation.packData) {
        pack.status = "invalid";
        pack.indexedAt = new Date().toISOString();
        await env.PACKS.put(`pack:${id}`, JSON.stringify(pack));
        continue;
      }

      // Update from fresh data
      pack.displayName = validation.packData.displayName;
      pack.description = validation.packData.description;
      pack.author = validation.packData.author;
      pack.components = validation.packData.components;
      pack.keywords = validation.packData.keywords;
      pack.status = "active";
    }

    pack.indexedAt = new Date().toISOString();
    await env.PACKS.put(`pack:${id}`, JSON.stringify(pack));
  }
}

export async function reindexSinglePack(
  identifier: string,
  env: Env
): Promise<void> {
  const raw = await env.PACKS.get(`pack:${identifier}`);
  if (!raw) return;

  const pack = JSON.parse(raw) as PackEntry;
  const metadata = await fetchRepoMetadata(pack.repoUrl, env.GITHUB_TOKEN);

  if (!metadata) {
    pack.status = "unavailable";
    pack.indexedAt = new Date().toISOString();
    await env.PACKS.put(`pack:${identifier}`, JSON.stringify(pack));
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
    await env.PACKS.put(`pack:${identifier}`, JSON.stringify(pack));
    return;
  }

  const validation = validateTechpackYaml(yamlContent);
  if (!validation.valid || !validation.packData) {
    pack.status = "invalid";
    pack.indexedAt = new Date().toISOString();
    await env.PACKS.put(`pack:${identifier}`, JSON.stringify(pack));
    return;
  }

  pack.displayName = validation.packData.displayName;
  pack.description = validation.packData.description;
  pack.author = validation.packData.author;
  pack.components = validation.packData.components;
  pack.keywords = validation.packData.keywords;
  pack.status = "active";
  pack.indexedAt = new Date().toISOString();

  await env.PACKS.put(`pack:${identifier}`, JSON.stringify(pack));
}
