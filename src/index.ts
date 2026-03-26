import type { Env } from "./types.js";
import { handleListPacks, handleGetPack, jsonResponse } from "./api/packs.js";
import { handleSubmit } from "./api/submit.js";
import { handleReindex } from "./api/reindex.js";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // API routes
    if (path.startsWith("/api/")) {
      return handleApiRoute(request, env, ctx, path);
    }

    // Static assets are handled by Cloudflare Pages automatically
    return new Response("Not Found", { status: 404 });
  },
};

async function handleApiRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string
): Promise<Response> {
  // GET /api/packs
  if (path === "/api/packs" && request.method === "GET") {
    return handleListPacks(request, env, ctx);
  }

  // GET /api/packs/:identifier
  const packMatch = path.match(/^\/api\/packs\/([a-z0-9][a-z0-9-]*)$/);
  if (packMatch && request.method === "GET") {
    return handleGetPack(packMatch[1], env, ctx);
  }

  // POST /api/submit
  if (path === "/api/submit" && request.method === "POST") {
    return handleSubmit(request, env);
  }

  // POST /api/reindex (manual trigger — for seeding and scheduled reindex via GitHub Actions)
  if (path === "/api/reindex" && request.method === "POST") {
    ctx.waitUntil(
      seedFromTechpacksJson(env).then(() => handleReindex(env))
    );
    return jsonResponse({ message: "Reindex triggered" });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

async function seedFromTechpacksJson(env: Env): Promise<void> {
  // This reads the packages.json from the repository via GitHub raw URL
  // For initial seeding, we trigger this manually
  const response = await fetch(
    "https://raw.githubusercontent.com/mcs-cli/registry/main/techpacks.json",
    { headers: { "User-Agent": "mcs-registry" } }
  );

  if (!response.ok) return;

  const urls = (await response.json()) as string[];
  const { fetchRepoMetadata, fetchTechpackYaml, parseGitHubUrl } = await import(
    "./lib/github.js"
  );
  const { validateTechpackYaml } = await import("./lib/validator.js");

  const identifiers: string[] = [];

  for (const repoUrl of urls) {
    const metadata = await fetchRepoMetadata(repoUrl, env.GITHUB_TOKEN);
    if (!metadata) continue;

    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) continue;

    const yamlContent = await fetchTechpackYaml(
      parsed.owner,
      parsed.repo,
      metadata.defaultBranch,
      env.GITHUB_TOKEN
    );
    if (!yamlContent) continue;

    const validation = validateTechpackYaml(yamlContent);
    if (!validation.valid || !validation.packData) continue;

    const pack = {
      identifier: validation.packData.identifier,
      displayName: validation.packData.displayName,
      description: validation.packData.description,
      author: validation.packData.author,
      repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
      defaultBranch: metadata.defaultBranch,
      latestTag: metadata.latestTag,
      stargazerCount: metadata.stargazerCount,
      pushedAt: metadata.pushedAt,
      components: validation.packData.components,
      keywords: validation.packData.keywords,
      status: "active" as const,
      indexedAt: new Date().toISOString(),
    };

    await env.PACKS.put(`pack:${pack.identifier}`, JSON.stringify(pack));
    identifiers.push(pack.identifier);
  }

  // Merge with existing index
  const existingRaw = await env.PACKS.get("index:all");
  const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
  const merged = [...new Set([...existing, ...identifiers])].sort();
  await env.PACKS.put("index:all", JSON.stringify(merged));
}
