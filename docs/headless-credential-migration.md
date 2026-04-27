# Headless Credential Migration and Client Integration

This guide describes a practical operator workflow for migrating web-login credentials from a desktop/browser-capable environment into a headless Chat2API server deployment, then integrating OpenAI-compatible clients.

## Scope

This workflow is intentionally focused on:

1. Local login and credential capture.
2. Provider/account export and secure transfer.
3. Headless import and validation.
4. OpenAI-compatible client integration.

Out of scope for this guide:

- Browser automation or OAuth automation.
- Provider adapter changes.
- Credential encryption redesign.
- Cloud backup workflows.

## End-to-end workflow

### 1) Use a desktop/browser-capable environment for login

In a local desktop environment (Electron app or browser-capable runtime), complete provider login flows and capture the required credential fields.

### 2) Create or update provider/account entries locally

In the dashboard:

- Create/update providers.
- Create/update accounts under each provider.
- Save credentials and optional metadata.

### 3) Export provider/account backup (with credentials enabled)

From **Settings → Provider/Account Backup**:

1. Enable **Include account credentials in export (sensitive)**.
2. Click **Export provider/account backup**.
3. Save the JSON file to a secure temporary path.

### 4) Transfer backup securely to the headless server

Use only secure transfer methods (for example, SSH/SCP/SFTP over trusted networks). Avoid insecure sharing channels.

### 5) Import into headless dashboard

On the server-side dashboard:

1. Open **Settings → Provider/Account Backup**.
2. Use **Import from JSON file** (or paste JSON into the textarea).
3. Run **Dry run import** first.
4. If results look correct, run **Import now**.

### 6) Validate accounts manually

After import, go to Providers/Accounts and validate each imported account. Confirm health metadata updates (for example `healthStatus`, timestamps, failure reason, and model visibility where applicable).

### 7) Run headless smoke test

Use the helper script:

```bash
bash scripts/headless-openai-smoke-test.sh
```

Reference: `docs/headless-openai-smoke-test.md`.

### 8) Configure clients (Open WebUI / Hermes / OpenClaw)

Use Chat2API OpenAI-compatible endpoint:

```text
http://127.0.0.1:8081/v1
```

If deployed behind reverse proxy, use your proxy URL and make sure it ends with `/v1`.

## Security warnings (read before migration)

- Exported backups with credentials are equivalent to active login/session tokens.
- Never upload credential-containing backups to GitHub, chat tools, logs, tickets, or public object storage.
- Transfer backups only with secure methods over trusted channels.
- Delete temporary backup files after successful import and verification.
- Keep dashboard routes bound to localhost or protected network boundaries.
- Always set and protect `CHAT2API_DASHBOARD_TOKEN` for `/dashboard-api/*`.

## Client integration notes

- Default OpenAI-compatible base URL: `http://127.0.0.1:8081/v1`.
- Behind reverse proxy: use the proxy URL ending in `/v1`.
- `CHAT2API_DASHBOARD_TOKEN` protects `/dashboard-api/*` only; it is **not** an OpenAI API key.
- If Chat2API API key auth is enabled for `/v1/*`, clients must send `Authorization: Bearer <chat2api-api-key>`.
- Hermes/OpenClaw feature behavior can depend on model tool/function-call compatibility.
- Web-login providers may vary in tool/function support and can change behavior over time.

## Provider migration checklist

Use this checklist per provider after import:

- [ ] Provider appears in dashboard.
- [ ] Account appears under provider.
- [ ] Account validation updates `healthStatus`.
- [ ] `/v1/models` includes expected model.
- [ ] Optional: `POST /v1/chat/completions` smoke request succeeds.
- [ ] Open WebUI/Hermes/OpenClaw can send a normal chat request successfully.

For expanded compatibility dimensions (tool/function support expectations, health mapping notes, and failure taxonomy), see `docs/provider-compatibility-matrix.md`.

## Limitations

- Migration is file-based and operator-driven.
- No automatic sync between desktop and headless instances.
- Validation remains partly manual because provider-side session/token states can expire independently.
