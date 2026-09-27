import type { Env, PackEntry } from "./src/types.js";
import { injectPackOgTags } from "./src/lib/og.js";
import { handleListPacks, handleGetPack, handleUpdatePackStatus, jsonResponse } from "./src/api/packs.js";
import { handleSubmit } from "./src/api/submit.js";
import { handleReindex } from "./src/api/reindex.js";

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

  // POST /api/reindex (metadata refresh — called by the scheduled Reindex & Validate workflow)
  if (path === "/api/reindex" && request.method === "POST") {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${env.REINDEX_SECRET}`) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    try {
      const result = await handleReindex(env);
      return jsonResponse({ message: "Reindex complete", ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[reindex] Fatal error: ${message}`);
      return jsonResponse({ error: "Reindex failed", message }, 500);
    }
  }

  // POST /api/packs/update-status (used by GitHub Actions validation workflow)
  if (path === "/api/packs/update-status" && request.method === "POST") {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${env.REINDEX_SECRET}`) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return handleUpdatePackStatus(request, env);
  }

  return jsonResponse({ error: "Not found" }, 404);
}
