# Provider Compatibility Matrix (Planning)

This document defines a **documentation-first compatibility baseline** for Chat2API providers in headless/server deployments.

It is intended to guide operator validation for:

- Open WebUI normal chat workloads.
- Hermes/OpenClaw chat + tool/function-call workflows.
- Health-status interpretation and incident triage.

> Scope note: this file is a planning/reference layer only. It does **not** change provider adapters, dashboard behavior, or runtime health mapping code.

## Matrix conventions

- **Built-in / custom**: current recommendation using Chat2API built-in adapters where available.
- **Tool/function support** status values:
  - `known` = confirmed to work in real use and should be tested continuously.
  - `unknown` = not yet validated sufficiently.
  - `unsupported` = provider/channel does not support (or is intentionally unavailable).
  - `provider-dependent` = varies by model tier, account entitlements, or upstream web behavior.
- **Validation method** is the current practical method for this repo phase: dashboard manual validate + OpenAI-compatible endpoint checks.

## Provider matrix

| Provider | Chat2API provider id | Auth type | Expected credential fields | Built-in/custom | Expected model names/families | Validation method | Known limitations | Tool/function-call support | Open WebUI normal chat | Hermes/OpenClaw tool use | Health-status mapping notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Kimi | `kimi` | `jwt` | `token` (JWT or refresh token style) | Built-in | `Kimi-K2.5` / `kimi-k2.5` family | Manual account validation + `/v1/models` + chat completion probes | Web token lifetime can be short; upstream schema drift risk | provider-dependent | Suitable | Unknown → treat as conditional | Map auth failures to `unhealthy`; transient upstream 5xx/rate limits to `degraded`; unknown startup state to `unknown`. |
| DeepSeek | `deepseek` | `userToken` | `token` | Built-in | `DeepSeek-V3.2`, `DeepSeek-Search`, `DeepSeek-R1`, `DeepSeek-R1-Search` | Manual account validation (token check endpoint) + `/v1/models` + non-stream/stream chat checks | Search/reasoning variants may behave differently from baseline chat; rate-limit pressure possible | provider-dependent | Suitable | Provider-dependent; verify per model | Authentication errors should become `unhealthy`; partial model failures may be `degraded`; successful validation with no recent traffic can remain `healthy`/`unknown` per operator policy. |
| Qwen / Tongyi (CN) | `qwen` | `tongyi_sso_ticket` | `ticket` | Built-in | `Qwen3`, `Qwen3-Max`, `Qwen3-Max-Thinking`, `Qwen3-Plus`, `Qwen3.5-Plus`, `Qwen3-Flash`, `Qwen3-Coder` | Manual account validation + `/v1/models` + non-stream/stream chat checks | SSO cookie/ticket expiry and regional controls are common | provider-dependent | Suitable | Provider-dependent; especially for coder/thinking variants | If ticket invalid/expired: `unhealthy`; if model-specific errors only: `degraded`; if not yet validated after import: `unknown`. |
| Qwen AI (Global) | `qwen-ai` | `jwt` | `token`, optional `cookies` | Built-in | Qwen global model family (for example `Qwen3.6-Plus`, `Qwen3.5-Plus`, `Qwen3-Coder`, `Qwen2.5-Max`) | Manual account validation + `/v1/models` sync + non-stream/stream chat checks | Model catalog can change quickly; optional cookies may be required in some sessions | provider-dependent | Suitable | Provider-dependent; must verify per selected model | Missing/invalid JWT should map `unhealthy`; model list fetch failures with valid auth can be `degraded`; no validation yet should stay `unknown`. |
| GLM / Zhipu | `glm` | `refresh_token` | `refresh_token` | Built-in | `GLM-5` / `glm-5` family | Manual account validation (refresh endpoint) + `/v1/models` + chat checks | Refresh token expiry and anti-abuse checks can break flows suddenly | provider-dependent | Suitable | Provider-dependent | Refresh/auth failures => `unhealthy`; intermittent provider-side throttling => `degraded`; post-import unvalidated => `unknown`. |
| Z.ai | `zai` | `jwt` | `token` | Built-in | `GLM-5-Turbo`, `glm-5`, `glm-4.7`, `glm-4.6v`, `glm-4.6`, `glm-4.5v`, `glm-4.5-air` | Manual account validation + `/v1/models` + chat checks | Shared GLM family naming can cause model mapping ambiguity across clients | provider-dependent | Suitable | Provider-dependent | Invalid JWT/session => `unhealthy`; mapping mismatch or single-model failures => `degraded`; unknown import state => `unknown`. |
| MiniMax | `minimax` | `jwt` | `token`, optional `realUserID` | Built-in | `MiniMax-M2.5`, `MiniMax-M2.7` | Manual account validation + `/v1/models` + non-stream/stream chat checks | Account identity coupling (`realUserID`) can produce false-negative auth checks if mismatched | provider-dependent | Suitable | Provider-dependent; verify tool call payload compatibility | Credential mismatch should map `unhealthy`; capability mismatch/tool errors with valid auth should map `degraded`; not yet validated should be `unknown`. |
| Mimo | `mimo` | `cookie` | `service_token`, `user_id`, `ph_token` | Built-in | `mimo-v2-pro`, `mimo-v2-flash-studio`, `mimo-v2-omni` | Manual account validation (field presence + downstream request probes) + `/v1/models` + chat checks | Validation is weaker when only credential-format checks pass; runtime request probe is required | unknown | Suitable for basic chat after probe | Unknown; likely provider-dependent | Missing cookie fields => `unhealthy`; passes format check but fails runtime chat => `degraded`; newly imported and untested => `unknown`. |
| Perplexity (if enabled in deployment) | `perplexity` | `cookie` | `sessionToken` | Built-in | `Auto`, `Turbo`, `PPLX-Pro`, `GPT-5`, `Gemini-2.5-Pro`, `Claude-Sonnet-4`, `Claude-Opus-4`, `Nemotron` | Manual account validation + `/v1/models` + chat checks | Upstream model availability varies by subscription/account state; search-heavy behavior may differ from chat-only expectations | provider-dependent | Suitable | Provider-dependent; validate tool semantics per model | Session-token errors => `unhealthy`; entitlement/model mismatch => `degraded`; pre-validation import state => `unknown`. |

## Real-provider validation checklist

Run this checklist per provider/account during staged rollout:

- [ ] Account can be added.
- [ ] Manual validation updates `healthStatus`.
- [ ] `/v1/models` includes expected models.
- [ ] `/v1/chat/completions` non-stream works.
- [ ] `/v1/chat/completions` stream works (if supported by provider/model).
- [ ] Open WebUI sends normal chat request successfully.
- [ ] Hermes/OpenClaw basic chat request works.
- [ ] Hermes/OpenClaw tool-call request either works or fails with a documented reason.

## Failure taxonomy (triage categories)

Use these categories when documenting incidents and validation outcomes:

1. **invalid credentials**
   - Wrong token/cookie/field values; rejected immediately.
2. **expired credentials**
   - Previously valid sessions no longer accepted.
3. **rate limited**
   - Provider-side quota or traffic throttling.
4. **region/IP risk**
   - Geo/IP controls, risk control challenges, or suspicious-login enforcement.
5. **provider changed web API**
   - Upstream endpoint/headers/payload format drift.
6. **model mapping issue**
   - Model id mismatch between Chat2API exposure and upstream provider id.
7. **streaming parse issue**
   - SSE/chunk format incompatibility or parser regressions.
8. **tool/function-call unsupported**
   - Model/provider path does not support tool use semantics required by client.
9. **network/proxy issue**
   - Local egress, DNS, TLS interception, reverse proxy, or timeout problems.

## Notes for operators

- Re-run this validation after provider login refresh, token rotation, major Chat2API upgrade, or upstream provider UI/API changes.
- Treat this matrix as a living operational contract; update status values after each real-provider test cycle.
