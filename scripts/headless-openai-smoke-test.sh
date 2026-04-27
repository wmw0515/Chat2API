#!/usr/bin/env bash
set -u

CHAT2API_BASE_URL="${CHAT2API_BASE_URL:-http://127.0.0.1:8081}"
CHAT2API_API_KEY="${CHAT2API_API_KEY:-}"
CHAT2API_TEST_MODEL="${CHAT2API_TEST_MODEL:-}"
CHAT2API_DASHBOARD_TOKEN="${CHAT2API_DASHBOARD_TOKEN:-}"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "PASS: $*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "FAIL: $*"
}

trim_trailing_slash() {
  printf '%s' "$1" | sed 's:/*$::'
}

BASE_URL="$(trim_trailing_slash "$CHAT2API_BASE_URL")"

TMP_BODY="$(mktemp)"
cleanup() {
  rm -f "$TMP_BODY"
}
trap cleanup EXIT

request() {
  # args: METHOD URL [JSON_BODY] [AUTH_MODE]
  # AUTH_MODE: v1 | dashboard | none
  method="$1"
  url="$2"
  body="${3:-}"
  auth_mode="${4:-none}"

  set -- -sS -o "$TMP_BODY" -w "%{http_code}" -X "$method"

  if [ "$auth_mode" = "v1" ] && [ -n "$CHAT2API_API_KEY" ]; then
    set -- "$@" -H "Authorization: Bearer $CHAT2API_API_KEY"
  fi

  if [ "$auth_mode" = "dashboard" ] && [ -n "$CHAT2API_DASHBOARD_TOKEN" ]; then
    set -- "$@" -H "X-Dashboard-Token: $CHAT2API_DASHBOARD_TOKEN"
  fi

  if [ -n "$body" ]; then
    set -- "$@" -H "Content-Type: application/json" --data "$body"
  fi

  code=$(curl "$@" "$url")
  curl_exit=$?

  if [ "$curl_exit" -ne 0 ]; then
    echo "CURL_ERROR"
    return
  fi

  echo "$code"
}

echo "Chat2API headless OpenAI smoke test"
echo "Base URL: $BASE_URL"

# 1) health
health_code=$(request GET "$BASE_URL/health")
if [ "$health_code" = "200" ]; then
  pass "GET /health returned 200"
else
  fail "GET /health returned ${health_code:-unknown}"
fi

# 2) models
models_code=$(request GET "$BASE_URL/v1/models" "" "v1")
if [ "$models_code" = "200" ]; then
  if rg -q '"data"' "$TMP_BODY"; then
    pass "GET /v1/models returned 200 with model payload"
  else
    fail "GET /v1/models returned 200 but response did not include expected data field"
  fi
elif [ "$models_code" = "401" ]; then
  fail "GET /v1/models returned 401 (set CHAT2API_API_KEY if API key auth is enabled)"
else
  fail "GET /v1/models returned ${models_code:-unknown}"
fi

# 3) optional chat completion
if [ -n "$CHAT2API_TEST_MODEL" ]; then
  chat_payload=$(cat <<JSON
{"model":"$CHAT2API_TEST_MODEL","messages":[{"role":"user","content":"Reply with exactly: smoke-test-ok"}],"stream":false}
JSON
)
  chat_code=$(request POST "$BASE_URL/v1/chat/completions" "$chat_payload" "v1")
  if [ "$chat_code" = "200" ]; then
    if rg -q '"choices"' "$TMP_BODY"; then
      pass "POST /v1/chat/completions returned 200 with choices"
    else
      fail "POST /v1/chat/completions returned 200 but response did not include expected choices field"
    fi
  elif [ "$chat_code" = "401" ]; then
    fail "POST /v1/chat/completions returned 401 (set CHAT2API_API_KEY if API key auth is enabled)"
  else
    fail "POST /v1/chat/completions returned ${chat_code:-unknown}"
  fi
else
  echo "SKIP: POST /v1/chat/completions (set CHAT2API_TEST_MODEL to enable)"
fi

# 4) optional dashboard-api auth check
if [ -n "$CHAT2API_DASHBOARD_TOKEN" ]; then
  dashboard_code=$(request GET "$BASE_URL/dashboard-api/health" "" "dashboard")
  if [ "$dashboard_code" = "200" ]; then
    pass "GET /dashboard-api/health returned 200 with dashboard token"
  elif [ "$dashboard_code" = "401" ]; then
    fail "GET /dashboard-api/health returned 401 with provided dashboard token"
  else
    fail "GET /dashboard-api/health returned ${dashboard_code:-unknown}"
  fi
else
  echo "SKIP: GET /dashboard-api/health with token (set CHAT2API_DASHBOARD_TOKEN to enable)"
fi

echo
echo "Summary: PASS=$PASS_COUNT FAIL=$FAIL_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi

exit 0
