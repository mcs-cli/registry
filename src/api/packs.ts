import type { Env, PackEntry } from "../types.js";
import { reindexSinglePack } from "./reindex.js";

export async function handleListPacks(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.toLowerCase().trim() ?? "";
  const sort = url.searchParams.get("sort") ?? "stars";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const includeAll = url.searchParams.get("include") === "all";

  const indexRaw = await env.PACKS.get("index:all");
  if (!indexRaw) {
    return jsonResponse({ packs: [], total: 0 });
  }

  const identifiers = JSON.parse(indexRaw) as string[];
  const packs: PackEntry[] = [];

  for (const id of identifiers) {
    const raw = await env.PACKS.get(`pack:${id}`);
    if (!raw) continue;
    const pack = JSON.parse(raw) as PackEntry;
    if (!includeAll && pack.status !== "active") continue;
    packs.push(pack);
  }

  let scored: Array<{ pack: PackEntry; score: number }>;

  if (query) {
    scored = packs
      .map((pack) => ({ pack, score: computeSearchScore(pack, query) }))
      .filter((entry) => entry.score > 0);
  } else {
    scored = packs.map((pack) => ({ pack, score: 0 }));
  }

  // Sort
  scored.sort((a, b) => {
    if (query && a.score !== b.score) return b.score - a.score;
    if (sort === "recent") {
      return new Date(b.pack.pushedAt).getTime() - new Date(a.pack.pushedAt).getTime();
    }
    return b.pack.stargazerCount - a.pack.stargazerCount;
  });

  const total = scored.length;
  const paginated = scored.slice(offset, offset + limit).map((entry) => entry.pack);

  return jsonResponse({ packs: paginated, total });
}

export async function handleGetPack(
  identifier: string,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const raw = await env.PACKS.get(`pack:${identifier}`);
  if (!raw) {
    return jsonResponse({ error: "Pack not found" }, 404);
  }

  const pack = JSON.parse(raw) as PackEntry;

  // On-demand stale refresh: if indexedAt is older than 1 hour, reindex in background
  const indexedAt = new Date(pack.indexedAt).getTime();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  if (indexedAt < oneHourAgo) {
    ctx.waitUntil(reindexSinglePack(identifier, env));
  }

  return jsonResponse(pack);
}

function computeSearchScore(pack: PackEntry, query: string): number {
  let score = 0;
  const q = query.toLowerCase();

  // Identifier exact match
  if (pack.identifier.toLowerCase() === q) {
    score += 100;
  } else if (pack.identifier.toLowerCase().includes(q)) {
    score += 50;
  }

  // Display name
  if (pack.displayName.toLowerCase().includes(q)) {
    score += 40;
  }

  // Keywords
  for (const kw of pack.keywords) {
    if (kw.toLowerCase() === q) {
      score += 30;
      break;
    }
    if (kw.toLowerCase().includes(q)) {
      score += 15;
      break;
    }
  }

  // Description
  if (pack.description.toLowerCase().includes(q)) {
    score += 20;
  }

  // Author
  if (pack.author?.toLowerCase().includes(q)) {
    score += 15;
  }

  return score;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
