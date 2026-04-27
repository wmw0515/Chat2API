# Headless Mode (Phase 1 + Browser Management Follow-up)

This phase adds a minimal backend-only runtime that starts the existing OpenAI-compatible proxy without Electron windows, tray, or IPC UI bootstrapping.

See also: `docs/headless-systemd.md` for a minimal Linux `systemd` deployment example.

## What changed

- Added a dedicated headless entrypoint: `src/main/headless.ts`.
- Added dual-runtime storage behavior in `src/main/store/store.ts`:
  - Electron runtime: keeps using `electron-store` + `safeStorage` encryption.
  - Headless Node runtime: still uses `electron-store` for persistence, but skips Electron `safeStorage` encryption APIs cleanly.
- Updated Perplexity proxy adapter to use `axios` HTTP calls instead of `electron.net`, so it can execute in headless Node mode.
- Added main-process build input for `headless` in `electron.vite.config.ts`.

## Run commands

```bash
npm install
npm run build
npm run start:headless
```

Optional environment variables:

- `CHAT2API_HOST` (default: value from config, usually `127.0.0.1`)
- `CHAT2API_PORT` (default: value from config, usually `8080`)
- `CHAT2API_DASHBOARD_TOKEN` (optional; when set, `/dashboard-api/*` requires this token)

Example:

```bash
CHAT2API_HOST=127.0.0.1 CHAT2API_PORT=8081 CHAT2API_DASHBOARD_TOKEN=your-dashboard-token npm run start:headless
```

## Browser dashboard support (follow-up scope)

Headless mode now serves the built renderer and a `/dashboard-api` surface that supports a practical provider/account workflow from the browser:

Security note:

- For development, you can leave `CHAT2API_DASHBOARD_TOKEN` unset.
- For headless/server use, set `CHAT2API_DASHBOARD_TOKEN` so dashboard API routes are protected.
- The dashboard API should not be exposed publicly without token protection and an additional network boundary (for example, localhost-only bind or trusted private network).
- Backup files generated with `includeCredentials=1` are sensitive and equivalent to active login/session tokens. Store and transfer them as secrets.


- Open dashboard in browser.
- View providers and accounts.
- Add/update/delete providers and accounts.
- Validate credentials (per-account and pre-save token validation).
- Export provider/account backup from `/dashboard-api/export` (credentials excluded by default).
- Import provider/account backup via `/dashboard-api/import` with optional `dryRun: true`.
- Persist data through the same store used by desktop/headless runtimes.

Recommended run/test flow:

```bash
npm install
npm run build
npm run start:headless
# open http://127.0.0.1:8081/#/providers
```

## Current limitations (intentionally out of scope)

- Browser/headless mode is intentionally not full dashboard parity (proxy settings, models, logs, sessions, about, and advanced desktop UX remain desktop-focused).
- Import-export scope remains minimal (no cloud backup, no Google Drive integration, no scheduled jobs, no encryption redesign).
- No full OAuth browser automation migration for web mode.
- Storage encryption differs by runtime:
  - Electron mode uses `safeStorage`.
  - Headless mode stores credentials without `safeStorage`-based encryption.
- No packaging/installer optimization yet for pure server distribution.
