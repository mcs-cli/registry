/**
 * Tests for the Worker's KV writers and GitHub helpers: reindex, the stale-view refresh,
 * update-status and index reconciliation. Run: `npx tsx scripts/test-reindex.ts`
 *
 * GitHub is replaced by a stubbed global `fetch` and KV by an in-memory namespace, so the
 * production code runs unchanged.
 */
import { handleReindex, reindexSinglePack } from "../src/api/reindex.js";
import { handleUpdatePackStatus } from "../src/api/packs.js";
import { reconcileIndex } from "../src/lib/packIndex.js";
import { batchFetchRepoMetadata, fetchTechpackYaml } from "../src/lib/github.js";
import type { Env, PackEntry } from "../src/types.js";

let pass = 0;
let fail = 0;

function eq<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log("  ok  ", label);
  } else {
    fail++;
    console.log("  FAIL", label);
    console.log("        expected:", expected);
    console.log("        actual:  ", actual);
  }
}

async function throws(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    eq(label, "resolved", "threw");
  } catch {
    eq(label, "threw", "threw");
  }
}

class MemoryKV {
  readonly store = new Map<string, string>();
  puts = 0;
  onGet?: (key: string) => void;

  async get(key: string): Promise<string | null> {
    this.onGet?.(key);
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.puts++;
    this.store.set(key, value);
  }
}

function makeEnv(kv: MemoryKV): Env {
  return { PACKS: kv, GITHUB_TOKEN: "t", REINDEX_SECRET: "s" } as unknown as Env;
}

function packEntry(slug: string, extra: Partial<PackEntry> = {}): PackEntry {
  const [, owner, repo] = slug.split("/");
  return {
    slug,
    identifier: repo,
    displayName: repo,
    description: "d",
    author: null,
    repoUrl: `https://github.com/${owner}/${repo}`,
    defaultBranch: "main",
    latestTag: null,
    stargazerCount: 1,
    pushedAt: "2026-09-01T00:00:00Z",
    components: { mcpServers: 0, hooks: 0, skills: 0, commands: 0, agents: 0, brewPackages: 0, plugins: 0, configurations: 0, templates: 0 },
    keywords: [],
    status: "active",
    indexedAt: "2026-09-01T00:00:00Z",
    ...extra,
  };
}

function seed(kv: MemoryKV, packs: PackEntry[]): void {
  for (const p of packs) kv.store.set(`pack:${p.slug}`, JSON.stringify(p));
  kv.store.set("index:all", JSON.stringify(packs.map((p) => p.slug).sort()));
  kv.puts = 0;
}

const repoData = (stars: number) => ({
  defaultBranchRef: { name: "main" },
  stargazerCount: stars,
  pushedAt: "2026-09-01T00:00:00Z",
  refs: { nodes: [] },
});

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

console.log("\n=== batchFetchRepoMetadata: found / notFound / unknown ===");
{
  stubFetch(() =>
    json({
      data: { repo0: repoData(5), repo1: null, repo2: null },
      errors: [
        { type: "NOT_FOUND", path: ["repo1"], message: "Could not resolve to a Repository" },
        { type: "FORBIDDEN", path: ["repo2"], message: "Repository access blocked" },
      ],
    })
  );
  const urls = ["https://github.com/a/found", "https://github.com/a/gone", "https://github.com/a/blocked"];
  const r = await batchFetchRepoMetadata(urls, "t");
  eq("existing repo is found", [...r.found.keys()], [urls[0]]);
  eq("NOT_FOUND alias is notFound", [...r.notFound], [urls[1]]);
  eq("FORBIDDEN alias is unknown, not gone", [...r.unknown], [urls[2]]);
}
{
  stubFetch(() => json({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }));
  await throws("error without an alias path throws for the whole batch", () =>
    batchFetchRepoMetadata(["https://github.com/a/b"], "t")
  );
}
{
  stubFetch(() => json({}, 502));
  await throws("HTTP failure throws", () => batchFetchRepoMetadata(["https://github.com/a/b"], "t"));
}

console.log("\n=== handleReindex ===");
{
  const kv = new MemoryKV();
  const blocked = packEntry("github/a/blocked", { warnings: ["w"], deepValidatedAt: "2026-09-02T00:00:00Z" });
  seed(kv, [blocked]);
  const before = new Map(kv.store);
  stubFetch(() =>
    json({ data: { repo0: null }, errors: [{ type: "FORBIDDEN", path: ["repo0"], message: "Repository access blocked" }] })
  );
  const result = await handleReindex(makeEnv(kv));
  eq("blocked repo leaves pack and index:all byte-identical", [...kv.store], [...before]);
  eq("blocked repo writes nothing", kv.puts, 0);
  eq("blocked repo counts as skipped, not as an error", [result.skipped, result.unavailable, result.errors.length], [1, 0, 0]);
}
{
  const kv = new MemoryKV();
  seed(kv, [packEntry("github/a/gone"), packEntry("github/a/kept")]);
  stubFetch(() =>
    json({ data: { repo0: null, repo1: repoData(1) }, errors: [{ type: "NOT_FOUND", path: ["repo0"], message: "x" }] })
  );
  const result = await handleReindex(makeEnv(kv));
  eq("NOT_FOUND marks the pack unavailable", JSON.parse(kv.store.get("pack:github/a/gone")!).status, "unavailable");
  eq("NOT_FOUND prunes the pack from index:all", JSON.parse(kv.store.get("index:all")!), ["github/a/kept"]);
  eq("unchanged pack is not rewritten", [result.unavailable, result.unchanged, result.removed], [1, 1, 1]);
}
{
  const kv = new MemoryKV();
  seed(kv, [packEntry("github/a/b")]);
  stubFetch(() => json({ data: null, errors: [{ type: "RATE_LIMITED", message: "x" }] }));
  const result = await handleReindex(makeEnv(kv));
  eq("whole-request failure aborts before any write", [kv.puts, result.errors.length], [0, 1]);
}

console.log("\n=== reindexSinglePack ===");
{
  const kv = new MemoryKV();
  seed(kv, [packEntry("github/a/b", { stargazerCount: 1 })]);
  // update-status lands while GitHub is answering the refresh.
  stubFetch(() => {
    kv.store.set(
      "pack:github/a/b",
      JSON.stringify(packEntry("github/a/b", { stargazerCount: 1, status: "invalid", validationErrors: ["e"], validatorVersion: "v2" }))
    );
    return json({ data: { repo0: repoData(9) } });
  });
  await reindexSinglePack("github/a/b", makeEnv(kv));
  const pack = JSON.parse(kv.store.get("pack:github/a/b")!) as PackEntry;
  eq("verdict written during the refresh is kept", [pack.status, pack.validationErrors, pack.validatorVersion], ["invalid", ["e"], "v2"]);
  eq("refresh still applies fresh metadata", pack.stargazerCount, 9);
}
{
  const kv = new MemoryKV();
  seed(kv, [packEntry("github/a/b")]);
  stubFetch(() => json({ data: { repo0: repoData(1) } }));
  await reindexSinglePack("github/a/b", makeEnv(kv));
  eq("unchanged metadata writes nothing", kv.puts, 0);
}
{
  const kv = new MemoryKV();
  seed(kv, [packEntry("github/a/b")]);
  stubFetch(() =>
    json({ data: { repo0: null }, errors: [{ type: "FORBIDDEN", path: ["repo0"], message: "Repository access blocked" }] })
  );
  await reindexSinglePack("github/a/b", makeEnv(kv));
  eq("blocked repo on refresh writes nothing", kv.puts, 0);
}
{
  const kv = new MemoryKV();
  const back = packEntry("github/a/b", { status: "unavailable", validationErrors: ["e"], deepValidatedAt: "2026-09-02T00:00:00Z" });
  kv.store.set("pack:github/a/b", JSON.stringify(back));
  kv.store.set("index:all", "[]");
  stubFetch(() => json({ data: { repo0: repoData(1) } }));
  await reindexSinglePack("github/a/b", makeEnv(kv));
  const pack = JSON.parse(kv.store.get("pack:github/a/b")!) as PackEntry;
  eq("returning pack gets its last verdict back", [pack.status, pack.deepValidatedAt], ["invalid", undefined]);
  eq("returning pack is listed again", JSON.parse(kv.store.get("index:all")!), ["github/a/b"]);
}

console.log("\n=== update-status ===");
{
  const kv = new MemoryKV();
  kv.store.set("pack:github/a/b", JSON.stringify(packEntry("github/a/b", { status: "unavailable" })));
  kv.store.set("index:all", "[]");
  const request = new Request("https://x/api/packs/update-status", {
    method: "POST",
    body: JSON.stringify({ slug: "github/a/b", status: "active" }),
  });
  const res = await handleUpdatePackStatus(request, makeEnv(kv));
  eq("a verdict cannot revive an unavailable pack", [res.status, kv.puts], [409, 0]);
}

console.log("\n=== reconcileIndex ===");
{
  const kv = new MemoryKV();
  seed(kv, [packEntry("github/a/b")]);
  await reconcileIndex(makeEnv(kv), packEntry("github/a/b"));
  eq("consistent index is not rewritten", kv.puts, 0);
  await reconcileIndex(makeEnv(kv), packEntry("github/a/c", { status: "invalid" }));
  eq("invalid pack is listed", JSON.parse(kv.store.get("index:all")!), ["github/a/b", "github/a/c"]);
}

console.log("\n=== fetchTechpackYaml ===");
{
  stubFetch(() => new Response("", { status: 404 }));
  eq("404 means no manifest", await fetchTechpackYaml("a", "b", "main", "t"), null);
  stubFetch(() => new Response("", { status: 500 }));
  await throws("any other failure throws", () => fetchTechpackYaml("a", "b", "main", "t"));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
