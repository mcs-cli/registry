# MCS Tech Pack Registry

The public registry for [MCS](https://mcs-cli.dev) tech packs. Browse, search, and submit packs at [techpacks.mcs-cli.dev](https://techpacks.mcs-cli.dev).

## Architecture

- **Frontend**: Static HTML/CSS/JS served by Cloudflare Pages
- **API**: Cloudflare Workers (edge functions)
- **Data**: Cloudflare KV (key-value store)
- **Bot prevention**: Cloudflare Turnstile
- **Reindexing & validation**: GitHub Actions every 6 hours — metadata via GitHub GraphQL, then the same checks as `mcs pack validate`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/packs` | List/search packs (`?q=`, `?sort=stars\|recent`, `?limit=`, `?offset=`) |
| `GET` | `/api/packs/:identifier` | Get a single pack |
| `POST` | `/api/submit` | Submit a new pack |
| `POST` | `/api/reindex` | Refresh repository metadata |

## Local Development

```bash
npm install
cp .dev.vars.example .dev.vars  # Edit with your tokens
npm run dev
```

## Deploy

```bash
npm run deploy
```

## Submit a Pack

Any public GitHub repository with a valid `techpack.yaml` at the root can be submitted. No account required — just paste the URL.

## License

MIT
