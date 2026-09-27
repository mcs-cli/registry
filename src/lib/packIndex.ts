import type { Env, PackEntry } from "../types.js";

/** Keeps `index:all` in step with a pack just written: listed unless unavailable. */
export async function reconcileIndex(env: Env, pack: PackEntry): Promise<void> {
  const indexRaw = await env.PACKS.get("index:all");
  const slugs: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  const listed = slugs.includes(pack.slug);
  const shouldList = pack.status !== "unavailable";
  if (listed === shouldList) return;

  const next = shouldList ? [...slugs, pack.slug].sort() : slugs.filter((s) => s !== pack.slug);
  await env.PACKS.put("index:all", JSON.stringify(next));
}
