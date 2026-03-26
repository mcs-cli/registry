import type { RepoMetadata } from "../types.js";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

const REPO_FIELDS_FRAGMENT = `
  defaultBranchRef { name }
  stargazerCount
  pushedAt
  refs(refPrefix: "refs/tags/", last: 1, orderBy: { field: TAG_COMMIT_DATE, direction: ASC }) {
    nodes { name }
  }
`;

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
  const match = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export async function fetchRepoMetadata(
  repoUrl: string,
  token: string
): Promise<RepoMetadata | null> {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) return null;

  const query = `
    query {
      repository(owner: "${parsed.owner}", name: "${parsed.repo}") {
        ${REPO_FIELDS_FRAGMENT}
      }
    }
  `;

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "mcs-registry",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) return null;

  const json = (await response.json()) as GraphQLResponse<{
    repository: RawRepoData | null;
  }>;

  const repo = json.data?.repository;
  if (!repo) return null;

  return mapRepoData(parsed.owner, parsed.repo, repo);
}

export async function batchFetchRepoMetadata(
  repoUrls: string[],
  token: string
): Promise<Map<string, RepoMetadata>> {
  const results = new Map<string, RepoMetadata>();
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

    const query = `query { ${aliases} }`;

    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "mcs-registry",
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) continue;

    const json = (await response.json()) as GraphQLResponse<
      Record<string, RawRepoData | null>
    >;
    if (!json.data) continue;

    batch.forEach((p, idx) => {
      const repo = json.data?.[`repo${idx}`];
      if (repo) {
        results.set(p.url, mapRepoData(p.owner, p.repo, repo));
      }
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

  if (!response.ok) return null;
  return response.text();
}

// -- Internal types --

interface RawRepoData {
  defaultBranchRef: { name: string } | null;
  stargazerCount: number;
  pushedAt: string;
  refs: { nodes: Array<{ name: string }> };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
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
