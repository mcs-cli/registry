import type { PackEntry } from "../types.js";

const TITLE_SUFFIX = " — MCS Tech Packs";

const STATIC_TITLE = "<title>MCS — Discover Tech Packs</title>";
const STATIC_OG_TITLE =
  '<meta property="og:title" content="MCS — Discover Tech Packs">';
const STATIC_OG_DESC =
  '<meta property="og:description" content="Browse, search, and submit tech packs for Claude Code. Find the right MCS configuration for your stack.">';
const STATIC_OG_URL =
  '<meta property="og:url" content="https://techpacks.mcs-cli.dev">';
const STATIC_META_DESC =
  '<meta name="description" content="Browse, search, and submit tech packs for Claude Code. Find the right MCS configuration for your stack.">';
const STATIC_OG_SITE_NAME =
  '<meta property="og:site_name" content="MCS Tech Packs">';
const STATIC_CANONICAL =
  '<link rel="canonical" href="https://techpacks.mcs-cli.dev">';

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function injectPackOgTags(
  html: string,
  pack: PackEntry,
  packUrl: string
): string {
  const title = escapeAttr(pack.displayName);
  const desc = escapeAttr(pack.description);
  const url = escapeAttr(packUrl);
  const fullDesc = pack.author
    ? `${desc} — by ${escapeAttr(pack.author)}`
    : desc;

  const twitterTags = [
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${title}${TITLE_SUFFIX}">`,
    `<meta name="twitter:description" content="${fullDesc}">`,
    '<meta name="twitter:image" content="https://techpacks.mcs-cli.dev/og-image.png">',
  ].join("\n");

  let result = html;
  result = result.replace(
    STATIC_TITLE,
    `<title>${title}${TITLE_SUFFIX}</title>`
  );
  result = result.replace(
    STATIC_OG_TITLE,
    `<meta property="og:title" content="${title}${TITLE_SUFFIX}">`
  );
  result = result.replace(
    STATIC_OG_DESC,
    `<meta property="og:description" content="${fullDesc}">`
  );
  result = result.replace(
    STATIC_META_DESC,
    `<meta name="description" content="${fullDesc}">`
  );
  result = result.replace(
    STATIC_OG_URL,
    `<meta property="og:url" content="${url}">`
  );
  result = result.replace(
    STATIC_CANONICAL,
    `<link rel="canonical" href="${url}">`
  );
  result = result.replace(
    STATIC_OG_SITE_NAME,
    `${STATIC_OG_SITE_NAME}\n${twitterTags}`
  );

  return result;
}
