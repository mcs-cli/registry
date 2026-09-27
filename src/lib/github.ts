import type { RepoMetadata, RepoTree } from "../types.js";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

const REPO_FIELDS_FRAGMENT = `
  defaultBranchRef { name }
  stargazerCount
  pushedAt
  refs(refPrefix: "refs/tags/", last: 1, orderBy: { field: TAG_COMMIT_DATE, direction: ASC }) {
    nodes { name }
  }
`;

/** A GitHub response that says nothing about the repository itself (rate limit, outage). */
export class GitHubApiError extends Error {
  readonly isRateLimit: boolean;

  constructor(response: Response, endpoint: string) {
    super(`GitHub API HTTP ${response.status} at ${endpoint}`);
    // GitHub also answers 403 for a single blocked repository; only these headers mean the token is exhausted.
    this.isRateLimit =
      response.status === 429 ||
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after");
  }
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
  const match = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** Null when GitHub reports the repository NOT_FOUND; any answer that says nothing about it throws. */
export async function fetchRepoMetadata(
  repoUrl: string,
  token: string
): Promise<RepoMetadata | null> {
  const { found, notFound } = await batchFetchRepoMetadata([repoUrl], token);
  if (notFound.has(repoUrl)) return null;
  const metadata = found.get(repoUrl);
  if (!metadata) throw new Error(`GitHub GraphQL could not resolve ${repoUrl}`);
  return metadata;
}

export interface BatchMetadata {
  found: Map<string, RepoMetadata>;
  // Only this set may mark a pack unavailable.
  notFound: Set<string>;
  // GitHub answered for this repository but not about its existence (e.g. FORBIDDEN for a blocked repo).
  unknown: Set<string>;
}

/**
 * Sorts every repository into found / NOT_FOUND / unknown. An error tied to one alias stays with
 * that repository, so one blocked repo cannot stall every reindex; an error for the whole request
 * throws, because a partial answer would be misread as "these repos are gone" and prune live packs
 * (the cascade that wiped index:all on 2026-05-05).
 */
export async function batchFetchRepoMetadata(
  repoUrls: string[],
  token: string
): Promise<BatchMetadata> {
  const results: BatchMetadata = { found: new Map(), notFound: new Set(), unknown: new Set() };
  const parsed = repoUrls
    .map((url) => ({ url, ...parseGitHubUrl(url) }))
    .filter(
      (p): p is { url: string; owner: string; repo: string } =>
        p.owner !== undefined && p.repo !== undefined
    );

  // GraphQL batch: up to 50 repos per query
  const batchSize = 50;
  for (let i = 0; i < parsed.length; i += batchSize) {
    const batch = parsed.slice(i, i + batchSize);
    const aliases = batch
      .map(
        (p, idx) =>
          `repo${idx}: repository(owner: "${p.owner}", name: "${p.repo}") { ${REPO_FIELDS_FRAGMENT} }`
      )
      .join("\n");

    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "mcs-registry",
      },
      body: JSON.stringify({ query: `query { ${aliases} }` }),
    });
    if (!response.ok) throw new GitHubApiError(response, "graphql");

    const json = (await response.json()) as GraphQLResponse<Record<string, RawRepoData | null>>;
    const aliasErrors = new Map<string, GraphQLError>();
    for (const error of json.errors ?? []) {
      const alias = error.path?.[0];
      if (typeof alias !== "string" || !/^repo\d+$/.test(alias)) {
        throw new Error(`GitHub GraphQL batch error: ${error.type ?? "unknown"}: ${error.message}`);
      }
      aliasErrors.set(alias, error);
    }
    if (!json.data) throw new Error("GitHub GraphQL batch error: no data");

    batch.forEach((p, idx) => {
      const alias = `repo${idx}`;
      const repo = json.data?.[alias];
      const error = aliasErrors.get(alias);
      if (repo) results.found.set(p.url, mapRepoData(p.owner, p.repo, repo));
      else if (!error || error.type === "NOT_FOUND") results.notFound.add(p.url);
      else results.unknown.add(p.url);
    });
  }

  return results;
}

export async function fetchTechpackYaml(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/techpack.yaml?ref=${branch}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3.raw",
      "User-Agent": "mcs-registry",
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new GitHubApiError(response, `repos/${owner}/${repo}/contents/techpack.yaml`);
  return response.text();
}

/** Null only when GitHub truncated the tree; a failed request throws. */
export async function fetchRepoTree(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<RepoTree | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "User-Agent": "mcs-registry",
    },
  });

  if (!response.ok) throw new GitHubApiError(response, `repos/${owner}/${repo}/git/trees`);

  const json = (await response.json()) as GitTreeResponse;

  if (json.truncated) {
    console.log(
      `[github] Tree for ${owner}/${repo} was truncated (${json.tree.length} entries) — skipping file validation`
    );
    return null;
  }

  const files = new Set<string>();
  const directories = new Set<string>();

  for (const entry of json.tree) {
    if (entry.type === "blob") {
      files.add(entry.path);
    } else if (entry.type === "tree" || entry.type === "commit") {
      // A submodule is a directory in the checkout mcs validates.
      directories.add(entry.path);
    }
  }

  return { files, directories };
}

// -- Internal types --

interface RawRepoData {
  defaultBranchRef: { name: string } | null;
  stargazerCount: number;
  pushedAt: string;
  refs: { nodes: Array<{ name: string }> };
}

interface GitTreeResponse {
  sha: string;
  url: string;
  tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
  truncated: boolean;
}

interface GraphQLError {
  message: string;
  type?: string;
  path?: Array<string | number>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

function mapRepoData(
  owner: string,
  repo: string,
  data: RawRepoData
): RepoMetadata {
  const tagNodes = data.refs?.nodes ?? [];
  return {
    owner,
    repo,
    defaultBranch: data.defaultBranchRef?.name ?? "main",
    stargazerCount: data.stargazerCount,
    pushedAt: data.pushedAt,
    latestTag: tagNodes.length > 0 ? tagNodes[0].name : null,
  };
}
