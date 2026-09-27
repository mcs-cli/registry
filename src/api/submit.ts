import type { Env, PackEntry, SubmitRequest } from "../types.js";
import { fetchRepoMetadata, fetchRepoTree, fetchTechpackYaml, parseGitHubUrl } from "../lib/github.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { evaluatePack } from "../lib/packValidation.js";
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

  // Bot verification: Turnstile on first submit, HMAC confirmation token on "Submit Anyway"
  if (body.confirmWarnings && body.confirmationToken) {
    const valid = await verifyConfirmationToken(body.confirmationToken, body.repoUrl, ip, env.TURNSTILE_SECRET_KEY);
    if (!valid) {
      return jsonResponse({ error: "Confirmation expired. Please submit again." }, 403);
    }
  } else {
    if (!body.turnstileToken || typeof body.turnstileToken !== "string") {
      return jsonResponse({ error: "turnstileToken is required" }, 400);
    }
    const turnstileResult = await verifyTurnstile(
      body.turnstileToken,
      env.TURNSTILE_SECRET_KEY,
      ip
    );
    if (!turnstileResult.success) {
      return jsonResponse({ error: "Bot verification failed. Please try again." }, 403);
    }
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

  let evaluation: ReturnType<typeof evaluatePack>;
  let metadata: Awaited<ReturnType<typeof fetchRepoMetadata>>;
  try {
    metadata = await fetchRepoMetadata(repoUrl, env.GITHUB_TOKEN);
    if (!metadata) {
      return jsonResponse(
        { error: "Repository not found or not accessible. Make sure it's a public GitHub repository." },
        400
      );
    }
    const [yamlContent, repoTree] = await Promise.all([
      fetchTechpackYaml(metadata.owner, metadata.repo, metadata.defaultBranch, env.GITHUB_TOKEN),
      fetchRepoTree(metadata.owner, metadata.repo, metadata.defaultBranch, env.GITHUB_TOKEN),
    ]);
    evaluation = evaluatePack(yamlContent, repoTree);
  } catch (err) {
    console.error(`[submit] GitHub fetch failed for ${repoUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return jsonResponse({ error: "Could not reach GitHub to validate the repository. Please try again later." }, 502);
  }

  if (evaluation.status === "invalid" || !evaluation.packData) {
    return jsonResponse(
      {
        error: "Tech pack validation failed.",
        details: evaluation.errors,
        warnings: evaluation.warnings,
      },
      422
    );
  }

  if (evaluation.warnings.length > 0 && !body.confirmWarnings) {
    const confirmationToken = await generateConfirmationToken(body.repoUrl, ip, env.TURNSTILE_SECRET_KEY);
    return jsonResponse({
      requiresConfirmation: true,
      warnings: evaluation.warnings,
      confirmationToken,
    }, 200);
  }

  const now = new Date().toISOString();
  const pack: PackEntry = {
    slug,
    identifier: evaluation.packData.identifier,
    displayName: evaluation.packData.displayName,
    description: evaluation.packData.description,
    author: evaluation.packData.author,
    repoUrl,
    defaultBranch: metadata.defaultBranch,
    latestTag: metadata.latestTag,
    stargazerCount: metadata.stargazerCount,
    pushedAt: metadata.pushedAt,
    components: evaluation.packData.components,
    keywords: evaluation.packData.keywords,
    status: "active",
    indexedAt: now,
    warnings: evaluation.warnings.length > 0 ? evaluation.warnings : undefined,
    // This is the same verdict the scheduled validation would record, so it can skip the pack until the next push.
    deepValidatedAt: now,
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

const CONFIRMATION_TTL_SECONDS = 300; // 5 minutes

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function generateConfirmationToken(repoUrl: string, ip: string, secret: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const mac = await hmacSign(`${repoUrl}:${ip}:${ts}`, secret);
  return `${ts}:${mac}`;
}

async function verifyConfirmationToken(token: string, repoUrl: string, ip: string, secret: string): Promise<boolean> {
  const idx = token.indexOf(":");
  if (idx === -1) return false;
  const ts = parseInt(token.slice(0, idx), 10);
  if (isNaN(ts) || Math.floor(Date.now() / 1000) - ts > CONFIRMATION_TTL_SECONDS) return false;
  const expected = await hmacSign(`${repoUrl}:${ip}:${ts}`, secret);
  return expected === token.slice(idx + 1);
}
