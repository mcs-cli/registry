import type { Env } from "./src/types.js";
import { handleListPacks, handleGetPack, jsonResponse } from "./src/api/packs.js";
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
      return handleApiRoute(request, env, ctx, path);
    }

    // Static assets are handled by Cloudflare Pages via the asset binding
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env & { ASSETS: Fetcher }>;

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

  // POST /api/reindex (manual trigger — protected by shared secret)
  if (path === "/api/reindex" && request.method === "POST") {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${env.REINDEX_SECRET}`) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    ctx.waitUntil(handleReindex(env));
    return jsonResponse({ message: "Reindex triggered" });
  }

  return jsonResponse({ error: "Not found" }, 404);
}