# Vocs relay

The routing service for Vocs Code remote access (see [docs/REMOTE-ACCESS.md](../docs/REMOTE-ACCESS.md)).
A Cloudflare Worker + one Hub Durable Object per account. It routes opaque end-to-end-encrypted
frames between paired desktops and web clients and holds the pairing registry. It can never
read payload content — it sees routing metadata and ciphertext only.

## Deploy

```bash
cd relay
npx wrangler deploy
npx wrangler secret put ENROLL_TOKEN   # generate once, e.g. openssl rand -base64 32
```

Put the same secret in the desktop app (Settings → Remote access → Enrollment secret) and the
relay URL (e.g. `https://vocs-relay.<account>.workers.dev`) in the desktop's Relay URL field.
The web client (this directory's `public/`) is served by the same Worker at `/app` —
users pair by entering the code their desktop shows. Under the production layout the landing
Worker at `code.vocs.io` owns the hostname and forwards `/app`, `/v1` and `/ws` here, so the app
and the relay share one origin.

## Layout

- `src/core.ts` — pairing state machine + device registry (storage-agnostic, unit-tested)
- `src/routes.ts` — the deny-by-default HTTP route table and its authentication (Cloudflare-free, unit-tested)
- `src/rate.ts` — in-memory fixed-window rate limiter for the public pairing endpoints
- `src/worker.ts` — the Worker + Hub Durable Object (REST + WebSocket glue)
- `src/web-client.ts` — the browser-side pairing + e2e transport (DOM-free, unit-tested)
- `src/page.ts` — the web page logic (bundled to `app/app.js` via `npm run relay:page` at the repo root)
- `public/app/` — the static web client, served at `/app` (pairing screen, sessions, transcripts, approvals)

## Local development

```bash
cd relay && npx wrangler dev   # http://localhost:8787
```
