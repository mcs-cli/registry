import type { Env, PackEntry } from "./src/types.js";
import { EMPTY_COMPONENT_COUNTS } from "./src/types.js";
import { injectPackOgTags } from "./src/lib/og.js";
import { handleListPacks, handleGetPack, jsonResponse } from "./src/api/packs.js";
import { handleSubmit } from "./src/api/submit.js";
import { handleReindex } from "./src/api/reindex.js";
import {
  fetchRepoMetadata,
  fetchTechpackYaml,
  parseGitHubUrl,
} from "./src/lib/github.js";
import { validateTechpackYaml } from "./src/lib/validator.js";
import { validatePackFiles } from "./src/lib/file-validation.js";

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
      return handleApiRoute(request, env, ctx, url);
    }

    // Dynamic OG tags for pack deep-links: /?pack=github/owner/repo
    const packSlug = path === "/" ? url.searchParams.get("pack") : null;
    if (packSlug) {
      try {
        const [pack, assetResponse] = await Promise.all([
          env.PACKS.get<PackEntry>(`pack:${packSlug}`, "json"),
          env.ASSETS.fetch(request),
        ]);
        if (pack) {
          const html = await assetResponse.text();
          return new Response(injectPackOgTags(html, pack, url.href), {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=300, s-maxage=300",
            },
          });
        }
        return assetResponse;
      } catch (e) {
        console.error("[og] Failed to inject OG tags:", e);
      }
    }

    // Static assets are handled by Cloudflare Pages via the asset binding
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env & { ASSETS: Fetcher }>;

async function handleApiRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL
): Promise<Response> {
  const path = url.pathname;
  // GET /api/packs
  if (path === "/api/packs" && request.method === "GET") {
    return handleListPacks(request, env, ctx);
  }

  // GET /api/packs/:provider/:owner/:repo
  const packMatch = path.match(
    /^\/api\/packs\/(github)\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/
  );
  if (packMatch && request.method === "GET") {
    const slug = `${packMatch[1]}/${packMatch[2]}/${packMatch[3]}`;
    return handleGetPack(slug, env, ctx);
  }

  // POST /api/submit
  if (path === "/api/submit" && request.method === "POST") {
    return handleSubmit(request, env);
  }

  // POST /api/reindex (manual trigger — for seeding and scheduled reindex via GitHub Actions)
  if (path === "/api/reindex" && request.method === "POST") {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${env.REINDEX_SECRET}`) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    try {
      await seedFromTechpacksJson(env);
      const force = url.searchParams.get("force") === "true";
      const result = await handleReindex(env, { force });
      return jsonResponse({ message: "Reindex complete", ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[reindex] Fatal error: ${message}`);
      return jsonResponse({ error: "Reindex failed", message }, 500);
    }
  }

  return jsonResponse({ error: "Not found" }, 404);
}

async function seedFromTechpacksJson(env: Env): Promise<void> {
  const response = await fetch(
    "https://raw.githubusercontent.com/mcs-cli/registry/main/techpacks.json",
    { headers: { "User-Agent": "mcs-registry" } }
  );

  if (!response.ok) return;

  const urls = (await response.json()) as string[];
  const slugs: string[] = [];

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
    const slug = `github/${parsed.owner}/${parsed.repo}`;
    const canonicalUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;

    if (!validation.valid || !validation.packData) {
      // Store as invalid instead of silently skipping
      const invalidPack: PackEntry = {
        slug,
        identifier: "",
        displayName: "",
        description: "",
        author: null,
        repoUrl: canonicalUrl,
        defaultBranch: metadata.defaultBranch,
        latestTag: metadata.latestTag,
        stargazerCount: metadata.stargazerCount,
        pushedAt: metadata.pushedAt,
        components: EMPTY_COMPONENT_COUNTS,
        keywords: [],
        status: "invalid",
        indexedAt: new Date().toISOString(),
        validationErrors: validation.errors,
      };
      await env.PACKS.put(`pack:${slug}`, JSON.stringify(invalidPack));
      slugs.push(slug);
      continue;
    }

    // File-existence validation
    const fileValidation = await validatePackFiles(
      parsed.owner, parsed.repo, metadata.defaultBranch, env.GITHUB_TOKEN, validation.manifest
    );
    const fileErrors = fileValidation?.errors.length ? fileValidation.errors : undefined;
    const fileWarnings = fileValidation?.warnings.length ? fileValidation.warnings : undefined;

    const pack: PackEntry = {
      slug,
      identifier: validation.packData.identifier,
      displayName: validation.packData.displayName,
      description: validation.packData.description,
      author: validation.packData.author,
      repoUrl: canonicalUrl,
      defaultBranch: metadata.defaultBranch,
      latestTag: metadata.latestTag,
      stargazerCount: metadata.stargazerCount,
      pushedAt: metadata.pushedAt,
      components: validation.packData.components,
      keywords: validation.packData.keywords,
      status: fileErrors ? "invalid" : "active",
      indexedAt: new Date().toISOString(),
      warnings: fileWarnings,
      validationErrors: fileErrors,
    };

    await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));
    slugs.push(slug);
  }

  // Merge with existing index
  const existingRaw = await env.PACKS.get("index:all");
  const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
  const merged = [...new Set([...existing, ...slugs])].sort();
  await env.PACKS.put("index:all", JSON.stringify(merged));
}
