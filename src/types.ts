export interface PackEntry {
  slug: string;
  identifier: string;
  displayName: string;
  description: string;
  author: string | null;
  repoUrl: string;
  defaultBranch: string;
  latestTag: string | null;
  stargazerCount: number;
  pushedAt: string;
  components: ComponentCounts;
  keywords: string[];
  status: PackStatus;
  indexedAt: string;
}

export type PackStatus = "active" | "unavailable" | "invalid";

export interface ComponentCounts {
  mcpServers: number;
  hooks: number;
  skills: number;
  commands: number;
  agents: number;
  brewPackages: number;
  plugins: number;
  configurations: number;
  templates: number;
}

export interface RepoMetadata {
  owner: string;
  repo: string;
  defaultBranch: string;
  stargazerCount: number;
  pushedAt: string;
  latestTag: string | null;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  packData?: ExtractedPackData;
}

export interface ExtractedPackData {
  identifier: string;
  displayName: string;
  description: string;
  author: string | null;
  components: ComponentCounts;
  keywords: string[];
}

export interface SubmitRequest {
  repoUrl: string;
  turnstileToken: string;
  honeypot?: string;
}

export interface Env {
  PACKS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  TURNSTILE_SECRET_KEY: string;
  GITHUB_TOKEN: string;
  TURNSTILE_SITE_KEY: string;
  REINDEX_SECRET: string;
}
