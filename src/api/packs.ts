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

  const slugs = JSON.parse(indexRaw) as string[];

  const entries = await Promise.all(
    slugs.map((slug) => env.PACKS.get(`pack:${slug}`))
  );

  const packs: PackEntry[] = [];
  for (const raw of entries) {
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

  return jsonResponse({ packs: paginated, total, totalRegistered: slugs.length });
}

export async function handleGetPack(
  slug: string,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const raw = await env.PACKS.get(`pack:${slug}`);
  if (!raw) {
    return jsonResponse({ error: "Pack not found" }, 404);
  }

  const pack = JSON.parse(raw) as PackEntry;

  // On-demand stale refresh: if indexedAt is older than 1 hour, reindex in background
  const indexedAt = new Date(pack.indexedAt).getTime();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  if (indexedAt < oneHourAgo) {
    ctx.waitUntil(reindexSinglePack(slug, env));
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

  // Owner/repo match (slug is "github/owner/repo", match against owner/repo part)
  const ownerRepo = pack.slug.replace(/^github\//, "");
  if (ownerRepo.toLowerCase().includes(q)) {
    score += 35;
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

export interface UpdatePackStatusRequest {
  slug: string;
  status?: "active" | "invalid" | "unavailable";
  warnings?: string[];
  validationErrors?: string[];
  deepValidatedAt?: string;
}

export async function handleUpdatePackStatus(
  request: Request,
  env: Env
): Promise<Response> {
  let body: UpdatePackStatusRequest;
  try {
    body = (await request.json()) as UpdatePackStatusRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.slug || typeof body.slug !== "string") {
    return jsonResponse({ error: "slug is required" }, 400);
  }

  const VALID_STATUSES = ["active", "invalid", "unavailable"] as const;
  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return jsonResponse({ error: `Invalid status '${body.status}'. Must be one of: ${VALID_STATUSES.join(", ")}` }, 400);
  }

  const raw = await env.PACKS.get(`pack:${body.slug}`);
  if (!raw) {
    return jsonResponse({ error: `Pack '${body.slug}' not found` }, 404);
  }

  const pack = JSON.parse(raw) as PackEntry;

  if (body.status) pack.status = body.status;
  if (body.warnings !== undefined) pack.warnings = body.warnings.length > 0 ? body.warnings : undefined;
  if (body.validationErrors !== undefined) pack.validationErrors = body.validationErrors.length > 0 ? body.validationErrors : undefined;
  if (body.deepValidatedAt !== undefined) pack.deepValidatedAt = body.deepValidatedAt;
  pack.indexedAt = new Date().toISOString();

  await env.PACKS.put(`pack:${pack.slug}`, JSON.stringify(pack));

  // Update index: add if active, remove if not
  const indexRaw = await env.PACKS.get("index:all");
  const slugs: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  const inIndex = slugs.includes(pack.slug);

  if (pack.status === "active" && !inIndex) {
    slugs.push(pack.slug);
    slugs.sort();
    await env.PACKS.put("index:all", JSON.stringify(slugs));
  } else if (pack.status !== "active" && inIndex) {
    const filtered = slugs.filter((s) => s !== pack.slug);
    await env.PACKS.put("index:all", JSON.stringify(filtered));
  }

  return jsonResponse({ success: true, pack });
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
