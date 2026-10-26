# SPDX-License-Identifier: Apache-2.0
# All targets run inside the docker compose `dev` service; see compose.yaml.
RUN := docker compose run --rm dev

.PHONY: up down shell install lint format typecheck test check build db-migrate e2e-nile e2e-ton e2e-api php-selftest

up:            ## start PostgreSQL
	docker compose up -d --wait postgres
down:          ## stop services (data volume is kept)
	docker compose down
shell:         ## interactive shell in the dev container
	$(RUN) sh
install:       ## install dependencies from the lockfile, lifecycle scripts disabled
	$(RUN) npm ci --ignore-scripts
lint:
	$(RUN) npm run lint
format:
	$(RUN) npm run format
typecheck:
	$(RUN) npm run typecheck
test:
	$(RUN) npm test
check:         ## everything CI runs: lint, typecheck, layers, licenses, SPDX, tests
	$(RUN) npm run check
build:
	$(RUN) npm run build
db-migrate:
	$(RUN) npm run db:migrate
e2e-nile:      ## end-to-end scenario on TRON Nile testnet (manual payment), see docs/testnet.md
	docker compose run --rm -it dev npm run e2e:nile
e2e-ton:       ## end-to-end scenario on the TON testnet, see docs/ton-testnet.md
	$(RUN) npm run e2e:ton
e2e-api:       ## API + webhooks end to end (Nile replay, PHP receiver), see docs/api.md
	sh scripts/e2e-api.sh
PHP_IMAGE := php:8.4.27-cli-alpine@sha256:d8784155c4d37986be9ddd7a8950df7e78998cc48e35472cd69e2b9371424a65
php-selftest:  ## PHP example: syntax and webhook signature verification
	docker run --rm -v "$(CURDIR)/examples/php:/app:ro" -w /app $(PHP_IMAGE) sh -c 'php -l NocustodyClient.php && php -l webhook.php && php selftest.php'
