import type { Env, PackEntry, SubmitRequest } from "../types.js";
import { fetchRepoMetadata, fetchRepoTree, fetchTechpackYaml, parseGitHubUrl } from "../lib/github.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { validateTechpackYaml, validateFileReferences } from "../lib/validator.js";
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

  // Derive slug from URL
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return jsonResponse(
      { error: "Invalid URL. Must be a GitHub repository (https://github.com/owner/repo)." },
      400
    );
  }
  const slug = `github/${parsed.owner}/${parsed.repo}`;

  // Duplicate check — O(1) KV lookup
  const existingRaw = await env.PACKS.get(`pack:${slug}`);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as PackEntry;
    // Allow re-submission of packs that were previously marked invalid or unavailable
    if (existing.status === "active") {
      return jsonResponse(
        { error: `This repository is already registered as '${existing.displayName}'.`, pack: existing },
        409
      );
    }
    // Non-active pack — allow re-submission, will be overwritten below
  }

  // Fetch repo metadata
  const metadata = await fetchRepoMetadata(repoUrl, env.GITHUB_TOKEN);
  if (!metadata) {
    return jsonResponse(
      { error: "Repository not found or not accessible. Make sure it's a public GitHub repository." },
      400
    );
  }

  // Fetch techpack.yaml and repo tree in parallel (independent calls, saves a round-trip)
  const [yamlContent, repoTree] = await Promise.all([
    fetchTechpackYaml(metadata.owner, metadata.repo, metadata.defaultBranch, env.GITHUB_TOKEN),
    fetchRepoTree(parsed.owner, parsed.repo, metadata.defaultBranch, env.GITHUB_TOKEN),
  ]);

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

  // File-existence validation
  let fileWarnings: string[] = [];
  if (repoTree && validation.manifest) {
    const fileValidation = validateFileReferences(validation.manifest, repoTree);
    if (fileValidation.errors.length > 0) {
      return jsonResponse(
        {
          error: "techpack.yaml references files that don't exist in the repository.",
          details: fileValidation.errors,
          warnings: fileValidation.warnings,
        },
        422
      );
    }
    fileWarnings = fileValidation.warnings;
  }

  // Build pack entry
  const pack: PackEntry = {
    slug,
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
    warnings: fileWarnings.length > 0 ? fileWarnings : undefined,
  };

  // Store in KV
  await env.PACKS.put(`pack:${slug}`, JSON.stringify(pack));

  // Update index list
  const indexRaw = await env.PACKS.get("index:all");
  const slugs: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!slugs.includes(slug)) {
    slugs.push(slug);
    slugs.sort();
    await env.PACKS.put("index:all", JSON.stringify(slugs));
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
