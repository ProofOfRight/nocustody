#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Runs scripts/e2e-api.ts with the PHP webhook receiver from examples/php on the compose network, then checks that
# the receiver accepted (i.e. verified) the signed events. Host needs Docker only.
set -eu
PHP_IMAGE="php:8.4.27-cli-alpine@sha256:d8784155c4d37986be9ddd7a8950df7e78998cc48e35472cd69e2b9371424a65"
NAME=nocustody-e2e-php-hook
SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
docker compose up -d --wait postgres >/dev/null
NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$(docker compose ps -q postgres)")
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --network "$NETWORK" -v "$(pwd)/examples/php:/app:ro" -w /app \
  -e NOCUSTODY_WEBHOOK_SECRET="$SECRET" -e NOCUSTODY_WEBHOOK_LOG=/tmp/events.log \
  "$PHP_IMAGE" php -S 0.0.0.0:8000 webhook.php >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
status=0
docker compose run --rm -e E2E_WEBHOOK_URL="http://$NAME:8000/" -e E2E_WEBHOOK_SECRET="$SECRET" -e LOG_LEVEL=warn dev npm run -s e2e:api || status=$?
echo "--- events accepted by the PHP receiver (signature verified):"
docker exec "$NAME" sh -c 'cat /tmp/events.log 2>/dev/null' | sed 's/^/  /' || true
for type in invoice.created invoice.paid invoice.completed; do
  docker exec "$NAME" grep -q "\"type\":\"$type\"" /tmp/events.log || { echo "missing $type in PHP receiver"; status=1; }
done
[ "$status" -eq 0 ] && echo "E2E API + PHP webhook receiver OK" || echo "E2E API FAILED"
exit "$status"
