import type { RepoTree } from "../types.js";

// Mirrors mcs PackMarketplace (Sources/mcs/ExternalPack/PackMarketplace.swift), the parts of
// PluginRef (Sources/mcs/Core/PluginRef.swift) that `name@pack` resolution reads, and
// the free function pluginSourceRejectionReason in ExternalPackManifest.swift.

const PACK_TOKEN = "pack";
const PACK_MARKETPLACE_PREFIX = "mcs-";
const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

// Foundation's localizedDescription for every JSONSerialization failure; mcs prints it verbatim, so
// parity assumes mcs runs under an English locale.
const UNPARSEABLE_JSON = "The data couldn’t be read because it isn’t in the correct format.";

/** A `plugin:` component: its declared name and, for `name@pack`, the optional plugin directory. */
export interface DeclaredPlugin {
  name: string;
  source?: string;
}

interface HostedPlugin {
  bareName: string;
  /** As mcs's `relativePath` spells it: the source as written, `"."` for the pack root. */
  dir: string;
  manifestPath: string;
}

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

/**
 * Mirrors pluginSourceRejectionReason (ExternalPackManifest.swift): `.`, `./x` and `..` are refused rather
 * than normalised; leaving the key out is how a manifest names the pack root.
 */
export function pluginSourceRejectionReason(source: string, pluginName: string): string | null {
  const ref = parsePluginRef(pluginName);
  if (ref.marketplaceName !== PACK_TOKEN) {
    return `pluginSource applies only to a plugin the pack hosts ('${ref.bareName}@${PACK_TOKEN}')`;
  }
  const isPlainRelative = source !== "" && !source.startsWith("/")
    && !source.split("/").some((s) => s === "" || s === "." || s === "..");
  if (!isPlainRelative) {
    return `pluginSource '${source}' must be a path inside the pack such as 'plugins/${ref.bareName}'`
      + " (no leading './', '.', '..' or '/'); leave it out for the pack root";
  }
  return null;
}

/** Mirrors the reserved-marketplace check at the top of ExternalPackLoader.validatePackHostedPlugins. */
export function reservedMarketplaceError(plugins: DeclaredPlugin[]): string | null {
  for (const { name } of plugins) {
    const ref = parsePluginRef(name);
    if (ref.marketplaceName?.startsWith(PACK_MARKETPLACE_PREFIX)) {
      return `plugin '${name}': marketplaces named '${PACK_MARKETPLACE_PREFIX}…' are reserved for mcs;`
        + ` use '${ref.bareName}@${PACK_TOKEN}' for a plugin this pack hosts`;
    }
  }
  return null;
}

/** The `name@pack` plugins, in declaration order, with the plugin.json each must ship. */
function hostedPlugins(plugins: DeclaredPlugin[]): HostedPlugin[] {
  return plugins.flatMap(({ name, source }) => {
    const ref = parsePluginRef(name);
    if (ref.marketplaceName !== PACK_TOKEN) return [];
    const manifestPath = source === undefined ? PLUGIN_MANIFEST : `${source}/${PLUGIN_MANIFEST}`;
    return [{ bareName: ref.bareName, dir: source ?? ".", manifestPath }];
  });
}

/** The plugin.json files resolveHostedPlugins reads: those the tree lists, outside any symlink. */
export function pluginManifestPaths(plugins: DeclaredPlugin[], tree: RepoTree): string[] {
  const paths = new Set(hostedPlugins(plugins).map((p) => p.manifestPath));
  return [...paths].filter((path) => tree.files.has(path) && !crossesSymlink(path, tree));
}

/**
 * Mirrors PackMarketplace.hostedPlugins: each hosted plugin's directory, or the first failure as a
 * string, the only one mcs reports. `pluginManifests` maps a plugin.json path to its contents and
 * lacks every path the pack does not ship.
 */
export function resolveHostedPlugins(
  plugins: DeclaredPlugin[],
  pluginManifests: ReadonlyMap<string, string>,
  tree: RepoTree
): string[] | string {
  const dirs: string[] = [];
  for (const plugin of hostedPlugins(plugins)) {
    const error = resolveError(plugin, pluginManifests, tree);
    if (error) return error;
    dirs.push(plugin.dir);
  }
  return dirs;
}

// No escape check: pluginSourceRejectionReason refuses `..`, so only a symlink can leave the pack,
// and mcs resolves those itself.
function resolveError(
  { bareName, dir, manifestPath }: HostedPlugin,
  pluginManifests: ReadonlyMap<string, string>,
  tree: RepoTree
): string | null {
  // The tree cannot tell where a symlink points, so a plugin behind one is left to mcs; the
  // manifest path covers every prefix of the directory.
  if (crossesSymlink(manifestPath, tree)) return null;
  if (dir !== "." && !tree.directories.has(dir)) {
    return `the directory of plugin '${bareName}' is not a directory in the pack`;
  }
  const json = pluginManifests.get(manifestPath);
  if (json === undefined) return `plugin '${bareName}' has no ${manifestPath}`;
  const unreadable = (reason: string) => `the ${PLUGIN_MANIFEST} of plugin '${bareName}' could not be read: ${reason}`;
  let object: unknown;
  try {
    object = JSON.parse(json);
  } catch {
    return unreadable(UNPARSEABLE_JSON);
  }
  // JSONSerialization rejects a top-level scalar as unparseable, not as the wrong shape.
  if (object === null || typeof object !== "object") return unreadable(UNPARSEABLE_JSON);
  const declared = Array.isArray(object) ? undefined : (object as Record<string, unknown>).name;
  if (typeof declared !== "string") return unreadable("expected an object with a `name` string");
  if (declared !== bareName) return `plugin '${bareName}' is named '${declared}' in its ${PLUGIN_MANIFEST}`;
  return null;
}

function crossesSymlink(path: string, tree: RepoTree): boolean {
  let prefix = "";
  for (const segment of path.split("/")) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    if (tree.symlinks.has(prefix)) return true;
  }
  return false;
}
