# Headless Mode (Phase 1)

This phase adds a minimal backend-only runtime that starts the existing OpenAI-compatible proxy without Electron windows, tray, or IPC UI bootstrapping.

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

Example:

```bash
CHAT2API_HOST=0.0.0.0 CHAT2API_PORT=8080 npm run start:headless
```

## Current limitations (intentionally out of scope for Phase 1)

- No dashboard/UI migration (Electron renderer is unchanged).
- No IPC-driven management UX in headless mode (use API endpoints directly).
- Storage encryption differs by runtime:
  - Electron mode uses `safeStorage`.
  - Headless mode stores credentials without `safeStorage`-based encryption.
- No packaging/installer optimization yet for pure server distribution.
