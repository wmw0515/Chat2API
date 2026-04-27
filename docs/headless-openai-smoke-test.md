# Headless OpenAI-Compatible Smoke Test

This guide provides a minimal smoke test for Chat2API running in **headless server mode**.

For desktop-to-headless credential migration and client integration workflow, see `docs/headless-credential-migration.md`.

It verifies:
1. The server is reachable (`/health`).
2. OpenAI-compatible model listing works (`/v1/models`).
3. OpenAI-compatible chat completions work (`/v1/chat/completions`, optional).
4. Dashboard token protection does **not** affect `/v1/*` routes.
5. Dashboard API token protection works separately for `/dashboard-api/*`.

## Prerequisites

Start Chat2API in headless mode first:

```bash
npm run build
npm run start:headless
```

Optional runtime overrides:

```bash
CHAT2API_HOST=127.0.0.1 CHAT2API_PORT=8081 CHAT2API_DASHBOARD_TOKEN=your-dashboard-token npm run start:headless
```

## Helper script

Use the included helper script:

```bash
bash scripts/headless-openai-smoke-test.sh
```

Supported environment variables:

- `CHAT2API_BASE_URL` (default: `http://127.0.0.1:8081`)
- `CHAT2API_API_KEY` (optional; used as `Authorization: Bearer ...` on `/v1/*` requests)
- `CHAT2API_TEST_MODEL` (optional; when set, enables a minimal `POST /v1/chat/completions` test)
- `CHAT2API_DASHBOARD_TOKEN` (optional; when set, tests `/dashboard-api/health` with `X-Dashboard-Token`)
- `CHAT2API_INCLUDE_REASONING_CONTENT` (optional; default: off. Set to `1` to preserve upstream `reasoning_content` in OpenAI-compatible chat responses/chunks for debugging)

The script avoids printing sensitive token values.

## Examples

### 1) Basic health + models test

```bash
CHAT2API_BASE_URL=http://127.0.0.1:8081 \
  bash scripts/headless-openai-smoke-test.sh
```

### 2) Chat completion test with a selected model

```bash
CHAT2API_BASE_URL=http://127.0.0.1:8081 \
CHAT2API_TEST_MODEL=gpt-4o-mini \
  bash scripts/headless-openai-smoke-test.sh
```

### 3) API key auth enabled for `/v1/*`

If Chat2API API key auth is enabled in your configuration, `/v1/*` requires a Bearer API key:

```bash
CHAT2API_BASE_URL=http://127.0.0.1:8081 \
CHAT2API_API_KEY=replace-with-your-chat2api-api-key \
CHAT2API_TEST_MODEL=gpt-4o-mini \
  bash scripts/headless-openai-smoke-test.sh
```

### 4) Dashboard token test (separate from `/v1/*`)

```bash
CHAT2API_BASE_URL=http://127.0.0.1:8081 \
CHAT2API_DASHBOARD_TOKEN=replace-with-your-dashboard-token \
  bash scripts/headless-openai-smoke-test.sh
```

`CHAT2API_DASHBOARD_TOKEN` protects only `/dashboard-api/*` routes. It does **not** protect `/v1/*` routes.

## Open WebUI base URL

For Open WebUI, set the OpenAI-compatible base URL to:

```text
http://127.0.0.1:8081/v1
```

## Notes

- The smoke test is intentionally minimal and does not validate provider-specific behavior.
- No real credentials are required unless your deployment enables API key auth and/or you run the optional chat completion test.
- For OpenAI-compatible client behavior (Open WebUI/Hermes/OpenClaw, etc.), `reasoning_content` is filtered from chat responses by default. Set `CHAT2API_INCLUDE_REASONING_CONTENT=1` when you explicitly need raw reasoning traces for debugging.
