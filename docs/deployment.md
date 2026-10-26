# Deployment

The gateway ships as a container image. [deploy/compose.yaml](../deploy/compose.yaml) is a complete example:
PostgreSQL, a one-shot migration and the gateway running all roles in one process.

Before you start: receiving addresses belong to wallets whose keys stay **offline** (a hardware wallet). The
gateway only watches them. See [security.md](security.md) and [operations.md](operations.md).

## Image

`ghcr.io/proofofright/nocustody:<version>`, for `linux/amd64` and `linux/arm64`
([ADR-0028](adr/0028-container-image.md)):

- built `FROM scratch`: the official Node binary and its C/C++ runtime, the compiled application and its production
  dependencies; no shell, no package manager, no npm;
- runs as UID/GID 65532, application files are owned by root and read-only for the process;
- entrypoint is the CLI (`node /app/dist/app/cli.js`), the default command is `run`.

Always deploy a verified digest, not a tag; see [Verify the image](#verify-the-image).

## First start

1. Copy `deploy/compose.yaml` and `deploy/.env.example` into a directory on the server, rename the second one to
   `.env` and `chmod 600 .env`.
2. Write `config.json` next to it. Start from [examples/](../examples/) and the [configuration reference](configuration.md).
   Inside the container the API must listen on all interfaces: `"api": { "host": "0.0.0.0" }`; compose publishes it
   on the host's loopback only. The file contains no secrets (only names of environment variables) and must be
   readable by UID 65532: `chmod 644 config.json`.
3. Fill in `.env`: the image digest, `POSTGRES_PASSWORD` (`openssl rand -hex 32`) and every variable that
   `config.json` refers to by name (`apiKeyEnv`, `secretEnv`, `botTokenEnv`).
4. Pin the addresses and contracts. Check every address in `config.json` against the wallet itself (not against a
   chat or e-mail), then compute the checksum and put it into `.env` as `NOCUSTODY_PINNED_SHA256`:

   ```bash
   docker compose run --rm --no-deps migrate config:hash
   ```

5. Start. The `migrate` service applies migrations and exits; the gateway starts after it succeeds:

   ```bash
   docker compose up -d --wait
   ```

6. Create an API key for the merchant application (shown once, only its hash is stored):

   ```bash
   docker compose run --rm migrate apikey:create --name shop --scopes invoices:read,invoices:write,quotes:read
   ```

The `migrate` service is the same image with the CLI as entrypoint; any CLI command can be run through it
(`ops:status`, `apikey:list`, `webhook:retry-dead`, `invoice:show <id>`, …). See [src/app/cli.ts](../src/app/cli.ts).

The gateway refuses to start when the startup checks fail (pinned checksum, TON jetton-wallet binding) and blocks
new invoices if `config.json` changes while it runs. After changing the config, compute the new checksum, update
`.env` and recreate the containers (`docker compose up -d`). Many editors replace a file instead of rewriting it;
a bind-mounted file then keeps showing the old content inside the container until it is recreated.

## TLS and exposure

The API speaks plain HTTP and must be published through a TLS reverse proxy (nginx, Caddy, Traefik):

- `/v1/*` — for the merchant backend only; restrict by source address where possible;
- `/pay/*` — for payers, only if the [payment page](payment-page.md) is enabled;
- `/health` — for local monitoring; there is no need to publish it.

The proxy must not cache responses; the gateway sends `cache-control: no-store`.

## What the example compose file enforces

| Setting | Why |
|---|---|
| `read_only: true`, `tmpfs: /tmp` | nothing in the container can be modified at runtime |
| `user: 65532:65532`, `cap_drop: [ALL]`, `no-new-privileges` | no root, no capabilities, no privilege escalation |
| `pids_limit`, `mem_limit` | a bug or a flood cannot exhaust the host |
| API published on `127.0.0.1` | only the reverse proxy reaches it |
| internal network `db` | PostgreSQL is not reachable from outside and has no internet access |
| config mounted `:ro` | the gateway cannot change its own addresses |

## Running roles separately

All roles share the database and can run as separate services (or on separate hosts), for example a public API
host and an internal worker:

```yaml
  api:     { <<: *gateway, command: ["run", "--roles", "api"] }
  workers: { <<: *gateway, command: ["run", "--roles", "worker,dispatcher,monitor"] }
```

Run the [address canary](operations.md#address-canary) from a different host than the gateway.

## Upgrades

1. Read the [changelog](../CHANGELOG.md) for the target version.
2. Back up the database (below).
3. Verify the new image and put its digest into `NOCUSTODY_IMAGE`.
4. `docker compose up -d --wait`: migrations run first; the gateway starts only if they succeed.

## Backups

The database holds invoices, the audit log, API key hashes and the webhook outbox:

```bash
docker compose exec -T postgres pg_dump -U nocustody -Fc nocustody > nocustody-$(date +%F).dump
```

Keep `config.json` and `.env` in your secret store, separately from the dumps.
