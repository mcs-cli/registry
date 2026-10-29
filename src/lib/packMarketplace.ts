import type { RepoTree } from "../types.js";

// Mirrors mcs PackMarketplace (Sources/mcs/ExternalPack/PackMarketplace.swift) and the parts of
// PluginRef (Sources/mcs/Core/PluginRef.swift) that `name@pack` resolution reads.

export const PACK_MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";

const PACK_TOKEN = "pack";
const PACK_MARKETPLACE_PREFIX = "mcs-";

// Foundation's localizedDescription for every JSONSerialization failure; mcs prints it verbatim, so
// parity assumes mcs runs under an English locale.
const UNPARSEABLE_JSON = "The data couldn’t be read because it isn’t in the correct format.";

interface PluginRef {
  bareName: string;
  /** Only what the reference itself names; null for a bare name or an `@org/repo` reference. */
  marketplaceName: string | null;
}

// Swift `split(separator: "@", maxSplits: 1)` drops empty pieces, so `@pack` is a bare name, not a pack token,
// and `a@` stays the bare name `a@` — one piece keeps the full string.
function parsePluginRef(fullName: string): PluginRef {
  const match = /^@*([^@]+)@(.+)$/s.exec(fullName);
  if (!match) return { bareName: fullName, marketplaceName: null };
  const [, bareName, token] = match;
  return { bareName, marketplaceName: token.includes("/") ? null : token };
}

/** Mirrors the reserved-marketplace check at the top of ExternalPackLoader.validatePackHostedPlugins. */
export function reservedMarketplaceError(pluginNames: string[]): string | null {
  for (const name of pluginNames) {
    const ref = parsePluginRef(name);
    if (ref.marketplaceName?.startsWith(PACK_MARKETPLACE_PREFIX)) {
      return `plugin '${name}': marketplaces named '${PACK_MARKETPLACE_PREFIX}…' are reserved for mcs;`
        + ` use '${ref.bareName}@${PACK_TOKEN}' for a plugin this pack hosts`;
    }
  }
  return null;
}

/** The bare names of the plugins declared as `name@pack`, in declaration order. */
export function hostedPluginNames(pluginNames: string[]): string[] {
  return pluginNames
    .map(parsePluginRef)
    .filter((ref) => ref.marketplaceName === PACK_TOKEN)
    .map((ref) => ref.bareName);
}

/**
 * Mirrors PackMarketplace.hostedPlugins: each plugin's directory as mcs's `relativePath` spells it
 * (`"."` for the pack root), or the first failure as a string, the only one mcs reports.
 * `marketplaceJson` is null when the pack has no marketplace manifest.
 */
export function resolveHostedPlugins(
  pluginNames: string[],
  marketplaceJson: string | null,
  tree: RepoTree
): string[] | string {
  const names = hostedPluginNames(pluginNames);
  if (names.length === 0) return [];
  // The tree lists a symlinked `.claude-plugin` as one blob with nothing under it, and the contents API
  // cannot read through it; mcs follows the link, so a manifest behind one is left to mcs.
  if (marketplaceJson === null && crossesSymlink(PACK_MARKETPLACE_MANIFEST, tree)) return [];
  const entries = marketplaceEntries(marketplaceJson);
  if (typeof entries === "string") return entries;
  const dirs: string[] = [];
  for (const name of names) {
    const resolved = resolve(name, entries, tree);
    if ("error" in resolved) return resolved.error;
    dirs.push(resolved.dir);
  }
  return dirs;
}

function marketplaceEntries(json: string | null): Array<Record<string, unknown>> | string {
  if (json === null) return `no ${PACK_MARKETPLACE_MANIFEST} in the pack`;
  const unreadable = (reason: string) => `${PACK_MARKETPLACE_MANIFEST} could not be read: ${reason}`;
  let object: unknown;
  try {
    object = JSON.parse(json);
  } catch {
    return unreadable(UNPARSEABLE_JSON);
  }
  // JSONSerialization rejects a top-level scalar as unparseable, not as the wrong shape.
  if (object === null || typeof object !== "object") return unreadable(UNPARSEABLE_JSON);
  const plugins = (object as Record<string, unknown>).plugins;
  const isEntry = (p: unknown) => !!p && typeof p === "object" && !Array.isArray(p);
  if (!Array.isArray(plugins) || !plugins.every(isEntry)) {
    return unreadable("expected an object with a `plugins` list");
  }
  return plugins as Array<Record<string, unknown>>;
}

// `dir` keeps mcs's spelling (`./a/..` stays `a/..`): its heuristics compare it as a plain string.
function resolve(name: string, entries: Array<Record<string, unknown>>, tree: RepoTree): { dir: string } | { error: string } {
  const entry = entries.find((e) => e.name === name);
  if (!entry) return { error: `${PACK_MARKETPLACE_MANIFEST} lists no plugin named '${name}'` };
  const source = entry.source;
  if (typeof source !== "string" || !(source === "." || source.startsWith("./"))) {
    return { error: `plugin '${name}' in ${PACK_MARKETPLACE_MANIFEST} needs a relative \`source\` such as "./"` };
  }
  if (source === "." || source === "./") return { dir: "." };
  const dir = source.slice(2);
  const path = standardized(dir);
  if (path === null) {
    return { error: `the source of plugin '${name}' in ${PACK_MARKETPLACE_MANIFEST} points outside the pack` };
  }
  // mcs resolves symlinks before this test; the tree cannot, so a linked source is left to mcs.
  if (path !== "" && !crossesSymlink(path, tree) && !tree.directories.has(path)) {
    return { error: `the source of plugin '${name}' in ${PACK_MARKETPLACE_MANIFEST} is not a directory in the pack` };
  }
  return { dir };
}

// The pack-relative path with `.` and `..` applied; null when a `..` climbs out of the pack.
function standardized(relativePath: string): string | null {
  const segments: string[] = [];
  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  return segments.join("/");
}

function crossesSymlink(path: string, tree: RepoTree): boolean {
  let prefix = "";
  for (const segment of path.split("/")) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    if (tree.symlinks.has(prefix)) return true;
  }
  return false;
}
