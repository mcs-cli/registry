import type { Env, PackEntry, SubmitRequest } from "../types.js";
import { fetchRepoMetadata, fetchTechpackYaml, parseGitHubUrl } from "../lib/github.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { validateTechpackYaml } from "../lib/validator.js";
import { jsonResponse } from "./packs.js";

const MAX_SUBMISSIONS_PER_HOUR = 5;

export async function handleSubmit(
  request: Request,
  env: Env
): Promise<Response> {
  // Parse body
  let body: SubmitRequest;
  try {
    body = (await request.json()) as SubmitRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.repoUrl || typeof body.repoUrl !== "string") {
    return jsonResponse({ error: "repoUrl is required" }, 400);
  }
  if (!body.turnstileToken || typeof body.turnstileToken !== "string") {
    return jsonResponse({ error: "turnstileToken is required" }, 400);
  }

  // Honeypot check — bots fill hidden fields, humans don't
  if (body.honeypot) {
    // Silently return fake success so bots think it worked
    return jsonResponse({ success: true, identifier: "submitted" }, 201);
  }

  // Rate limiting by IP
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rateLimited = await checkRateLimit(ip, env);
  if (rateLimited) {
    return jsonResponse(
      { error: "Too many submissions. Please try again later." },
      429
    );
  }

  // Turnstile verification
  const turnstileResult = await verifyTurnstile(
    body.turnstileToken,
    env.TURNSTILE_SECRET_KEY,
    ip
  );
  if (!turnstileResult.success) {
    return jsonResponse(
      { error: "Bot verification failed. Please try again." },
      403
    );
  }

  // URL validation
  const repoUrl = normalizeGitHubUrl(body.repoUrl);
  if (!repoUrl) {
    return jsonResponse(
      { error: "Invalid URL. Must be a GitHub repository (https://github.com/owner/repo)." },
      400
    );
  }

  // Duplicate check
  const existing = await findPackByRepoUrl(repoUrl, env);
  if (existing) {
    return jsonResponse(
      { error: `This repository is already registered as '${existing.identifier}'.`, pack: existing },
      409
    );
  }

  // Fetch repo metadata
  const metadata = await fetchRepoMetadata(repoUrl, env.GITHUB_TOKEN);
  if (!metadata) {
    return jsonResponse(
      { error: "Repository not found or not accessible. Make sure it's a public GitHub repository." },
      400
    );
  }

  // Fetch techpack.yaml
  const yamlContent = await fetchTechpackYaml(
    metadata.owner,
    metadata.repo,
    metadata.defaultBranch,
    env.GITHUB_TOKEN
  );
  if (!yamlContent) {
    return jsonResponse(
      { error: "No techpack.yaml found at the repository root. This file is required for MCS tech packs." },
      400
    );
  }

  // Validate
  const validation = validateTechpackYaml(yamlContent);
  if (!validation.valid || !validation.packData) {
    return jsonResponse(
      {
        error: "techpack.yaml validation failed.",
        details: validation.errors,
      },
      422
    );
  }

  // Check identifier collision
  const existingById = await env.PACKS.get(`pack:${validation.packData.identifier}`);
  if (existingById) {
    const existingPack = JSON.parse(existingById) as PackEntry;
    if (existingPack.repoUrl !== repoUrl) {
      return jsonResponse(
        {
          error: `A pack with identifier '${validation.packData.identifier}' is already registered from a different repository.`,
        },
        409
      );
    }
  }

  // Build pack entry
  const pack: PackEntry = {
    identifier: validation.packData.identifier,
    displayName: validation.packData.displayName,
    description: validation.packData.description,
    author: validation.packData.author,
    repoUrl,
    defaultBranch: metadata.defaultBranch,
    latestTag: metadata.latestTag,
    stargazerCount: metadata.stargazerCount,
    pushedAt: metadata.pushedAt,
    components: validation.packData.components,
    keywords: validation.packData.keywords,
    status: "active",
    indexedAt: new Date().toISOString(),
  };

  // Store in KV
  await env.PACKS.put(`pack:${pack.identifier}`, JSON.stringify(pack));

  // Update index list
  const indexRaw = await env.PACKS.get("index:all");
  const identifiers: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!identifiers.includes(pack.identifier)) {
    identifiers.push(pack.identifier);
    identifiers.sort();
    await env.PACKS.put("index:all", JSON.stringify(identifiers));
  }

  // Increment rate limit counter
  await incrementRateLimit(ip, env);

  return jsonResponse({ success: true, pack }, 201);
}

function normalizeGitHubUrl(input: string): string | null {
  let url = input.trim();

  // Handle common variations
  url = url.replace(/\.git$/, "");
  url = url.replace(/\/$/, "");

  // Must be a GitHub URL
  const parsed = parseGitHubUrl(url);
  if (!parsed) return null;

  // Normalize to canonical form
  return `https://github.com/${parsed.owner}/${parsed.repo}`;
}

async function findPackByRepoUrl(
  repoUrl: string,
  env: Env
): Promise<PackEntry | null> {
  const indexRaw = await env.PACKS.get("index:all");
  if (!indexRaw) return null;

  const identifiers = JSON.parse(indexRaw) as string[];
  for (const id of identifiers) {
    const raw = await env.PACKS.get(`pack:${id}`);
    if (!raw) continue;
    const pack = JSON.parse(raw) as PackEntry;
    if (pack.repoUrl === repoUrl) return pack;
  }
  return null;
}

async function checkRateLimit(ip: string, env: Env): Promise<boolean> {
  const key = `rate:${ip}`;
  const raw = await env.RATE_LIMIT.get(key);
  if (!raw) return false;
  const count = parseInt(raw, 10);
  return count >= MAX_SUBMISSIONS_PER_HOUR;
}

async function incrementRateLimit(ip: string, env: Env): Promise<void> {
  const key = `rate:${ip}`;
  const raw = await env.RATE_LIMIT.get(key);
  const count = raw ? parseInt(raw, 10) + 1 : 1;
  // TTL of 1 hour
  await env.RATE_LIMIT.put(key, String(count), { expirationTtl: 3600 });
}
