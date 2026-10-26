#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Smoke test of the production image with the example deployment (deploy/compose.yaml): migrations, all roles,
# API key from the CLI, an invoice over HTTP, the payment page, and the hardening (non-root, read-only, no shell).
# Usage: sh scripts/smoke-image.sh [image]   (default: builds nocustody:smoke). Host needs Docker and curl.
set -eu
IMAGE=${1:-}
if [ -z "$IMAGE" ]; then
  IMAGE=nocustody:smoke
  docker build -q -t "$IMAGE" . >/dev/null
fi
DIR=$(mktemp -d)
PORT=${SMOKE_PORT:-58080}
COMPOSE="docker compose -p nocustody-smoke -f deploy/compose.yaml --project-directory $DIR"
cleanup() {
  [ "${status:-1}" -eq 0 ] || $COMPOSE logs --no-color gateway migrate 2>/dev/null | tail -40 || true
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT
fail() {
  echo "SMOKE FAILED: $*"
  exit 1
}

# Nile testnet asset; the receiving address is a public test address, nothing is ever paid to it.
cat >"$DIR/config.json" <<'EOF'
{
  "database": { "urlEnv": "DATABASE_URL" },
  "api": { "host": "0.0.0.0", "paymentPage": { "enabled": true } },
  "tron": { "network": "tron:nile", "apiUrl": "https://nile.trongrid.io", "startFrom": "2026-10-25T00:00:00Z",
            "pollInterval": "30s" },
  "assets": [
    {
      "id": "usdt-nile", "network": "tron:nile", "kind": "token",
      "contract": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", "decimals": 6, "symbol": "USDT", "priceSymbol": "USDT",
      "addresses": [{ "address": "TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq", "status": "active" }],
      "amounts": { "step": "0.01", "maxSlots": 99 }
    }
  ],
  "pricing": {
    "currencies": ["USD"],
    "manualRates": [{ "base": "USD", "quote": "USDT", "rate": "1", "setAt": "2026-10-25T00:00:00Z", "maxAge": "3650d" }]
  }
}
EOF
chmod 644 "$DIR/config.json"
cat >"$DIR/.env" <<EOF
NOCUSTODY_IMAGE=$IMAGE
NOCUSTODY_PORT=$PORT
POSTGRES_PASSWORD=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
LOG_LEVEL=warn
EOF
# The same command as in docs/deployment.md.
PIN=$($COMPOSE run --rm --no-deps migrate config:hash 2>/dev/null) || fail "config:hash"
echo "NOCUSTODY_PINNED_SHA256=$PIN" >>"$DIR/.env"

$COMPOSE up -d --wait --wait-timeout 120 >/dev/null 2>&1 || fail "deployment did not become healthy"
echo "ok   migrate completed, gateway healthy"

[ "$(docker inspect -f '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}' "$($COMPOSE ps -q gateway)")" = "65532:65532 true" ] ||
  fail "gateway is not non-root with a read-only root filesystem"
$COMPOSE exec -T gateway /bin/sh -c true >/dev/null 2>&1 && fail "image contains a shell"
$COMPOSE exec -T gateway /usr/local/bin/node -e "require('fs').writeFileSync('/app/x', '')" >/dev/null 2>&1 &&
  fail "application directory is writable"
echo "ok   non-root, read-only root filesystem, no shell"

TOKEN=$($COMPOSE exec -T gateway /usr/local/bin/node /app/dist/app/cli.js apikey:create --name smoke \
  --scopes invoices:read,invoices:write | sed -n 's/.*"token": "\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || fail "apikey:create returned no token"
BASE="http://127.0.0.1:$PORT"
curl -fsS "$BASE/health" | grep -q '"ok"' || fail "/health"
INVOICE=$(curl -fsS -X POST "$BASE/v1/invoices" -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "idempotency-key: smoke-1" -d '{"merchant_order_id":"smoke-1","price":{"amount":"1.00","currency":"USD"},"asset":"usdt-nile"}') ||
  fail "POST /v1/invoices"
ID=$(echo "$INVOICE" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')
[ -n "$ID" ] || fail "no invoice id in: $INVOICE"
echo "ok   API key from the CLI, invoice $ID over HTTP"

HEADERS=$(curl -fsS -o "$DIR/page.html" -D - "$BASE/pay/$ID?lang=en") || fail "GET /pay/$ID"
echo "$HEADERS" | grep -qi "^content-security-policy: default-src 'none'" || fail "payment page without CSP"
grep -q "TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq" "$DIR/page.html" || fail "payment page without the address"
curl -fsS "$BASE/pay/$ID/status" | grep -q '"status":"awaiting_payment"' || fail "/pay/$ID/status"
echo "ok   payment page and public status"

status=0
echo "SMOKE OK ($IMAGE)"
