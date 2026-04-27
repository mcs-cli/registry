# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MCS Tech Pack Registry — a public registry at `techpacks.mcs-cli.dev` for discovering, searching, and submitting tech packs for Claude Code. Built on Cloudflare Pages + Workers + KV (free tier).

## Commands

```bash
npm run build:worker  # esbuild bundles _worker.ts → public/_worker.js (required before deploy)
npm run typecheck     # tsc --noEmit
npm run dev           # build:worker + wrangler pages dev (local KV is empty)
npm run deploy        # build:worker + wrangler pages deploy
```

CI auto-deploys on push to main via `.github/workflows/deploy.yml`.

## Architecture

`_worker.ts` is the **sole entry point**. There is no `src/index.ts` — do not create one.

```
_worker.ts              → routes API traffic, falls back to env.ASSETS.fetch() for static files
src/api/packs.ts        → GET /api/packs, GET /api/packs/github/:owner/:repo
src/api/submit.ts       → POST /api/submit (Turnstile + honeypot + IP rate-limit)
src/api/reindex.ts      → POST /api/reindex (auth required, batch GitHub GraphQL)
src/lib/github.ts       → GitHub API helpers (GraphQL batch metadata, REST yaml fetch)
src/lib/validator.ts    → Manual techpack.yaml validation (Ajv cannot be used in Workers)
src/lib/glob.ts         → POSIX fnmatch + dir/ shortcut — mirrors mcs Sources/mcs/Core/GlobMatcher.swift
src/lib/builtinIgnore.ts→ BUILTIN_IGNORED_DIRS + BUILTIN_INFRASTRUCTURE_FILES — mirror mcs PackHeuristics.swift
src/lib/turnstile.ts    → Cloudflare Turnstile verification
public/                 → Static frontend (vanilla JS, no framework)
public/_worker.js       → BUILD ARTIFACT (gitignored, esbuild output)
```

The build pipeline: `esbuild _worker.ts --bundle → public/_worker.js`. Cloudflare Pages picks up `_worker.js` from the output directory automatically. Everything in `src/` is bundled at build time — nothing deploys separately.

`tsc` / `npm run build` targets `src/` only and outputs to `dist/` for type-checking. It is NOT used for production.

## KV Key Scheme

| Key | Value |
|-----|-------|
| `pack:github/<owner>/<repo>` | JSON `PackEntry` — one entry per pack |
| `index:all` | JSON `string[]` — sorted slug array (master index) |
| `rate:<ip>` | Submission count (RATE_LIMIT namespace, 1h TTL) |

The `github/` prefix future-proofs for other providers. The `identifier` field from `techpack.yaml` is display-only — not used as a key.

## API Routes

All routing is manual string matching in `_worker.ts → handleApiRoute()`.

| Method | Route | Auth |
|--------|-------|------|
| GET | `/api/packs` | Public |
| GET | `/api/packs/github/:owner/:repo` | Public (triggers background stale reindex if >1h old) |
| POST | `/api/submit` | Turnstile token |
| POST | `/api/reindex` | `Authorization: Bearer <REINDEX_SECRET>` |

## Key Gotchas

- **Ajv is banned** — Workers block `new Function()`. Validation is manual in `src/lib/validator.ts`. The JSON Schema file exists for documentation only.
- **`glob.ts` and `builtinIgnore.ts` mirror mcs verbatim** — registry/CLI parity is the contract. The matcher must not gain `**` support and the built-in sets are exact strings (not globs). Any drift means `mcs pack validate` and the registry website disagree on the same pack.
- **`public/_worker.js` is gitignored** — must be built before deploy. If API routes return HTML instead of JSON, the Worker wasn't bundled.
- **esbuild flags matter** — `--platform=browser` (not `neutral`) and `--conditions=workerd,worker,browser` are required.
- **`wrangler kv` defaults to local** — always pass `--remote` for production KV operations.
- **`wrangler-action` version** — deploy workflow sets `wranglerVersion: ""` to use the project's wrangler 4.x devDep, not the action's bundled 3.x.
- **Do NOT add `main` to `wrangler.toml`** — it makes wrangler treat the project as a Worker instead of Pages.

## Reindex Strategy

- **Scheduled**: GitHub Actions cron every 6h calls `POST /api/reindex`
- **On-demand**: `handleGetPack` fires background `reindexSinglePack` via `ctx.waitUntil` if data is >1h stale
- **Smart re-fetch**: `techpack.yaml` only re-fetched if `pushedAt` changed
- **Batch GraphQL**: Up to 50 repos per GitHub API call
- **Pack statuses**: `active | unavailable | invalid` — `unavailable` packs are pruned from `index:all` (KV entry kept, filtered from listing). `invalid` packs stay in `index:all` and render at the bottom of the grid with a red banner; the pack modal exposes a "Report issue" button that builds a prefilled GitHub issue URL. See `.claude/memories/decision_architecture_reindex_pruning_and_recovery.md`.

## Secrets

Cloudflare (via `wrangler pages secret put`): `TURNSTILE_SECRET_KEY`, `GITHUB_TOKEN`, `REINDEX_SECRET`

GitHub Actions: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `REINDEX_SECRET`, `REGISTRY_URL`
