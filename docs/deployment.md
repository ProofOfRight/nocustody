# Deployment

The gateway ships as a container image. [deploy/compose.yaml](../deploy/compose.yaml) is a complete example:
PostgreSQL, a one-shot migration and the gateway running all roles in one process.

Before you start: receiving addresses belong to wallets whose keys stay **offline** (a hardware wallet). The
gateway only watches them. See [security.md](security.md) and [operations.md](operations.md). For the first mainnet launch follow
[going-live.md](going-live.md).

## Image

`ghcr.io/proofofright/nocustody:<version>`, for `linux/amd64` and `linux/arm64`
([ADR-0028](adr/0028-container-image.md)):

- built `FROM scratch`: the official Node binary and its C/C++ runtime, the compiled application and its production
  dependencies; no shell, no package manager, no npm;
- runs as UID/GID 65532, application files are owned by root and read-only for the process;
- entrypoint is the CLI (`node /app/dist/app/cli.js`), the default command is `run`.

Always deploy a verified digest, not a tag; see [Verify the image](#verify-the-image).

## Verify the image

Each release image carries signed attestations made by the release workflow ([ADR-0029](adr/0029-release-provenance.md)):
SLSA build provenance and an SPDX SBOM. Verify the digest from the release notes with a current GitHub CLI
before deploying it:

```bash
IMAGE=ghcr.io/proofofright/nocustody@sha256:<digest>
gh attestation verify oci://$IMAGE --repo ProofOfRight/nocustody \
  --signer-workflow ProofOfRight/nocustody/.github/workflows/release.yml --source-ref refs/tags/v0.3.0
gh attestation verify oci://$IMAGE --repo ProofOfRight/nocustody \
  --signer-workflow ProofOfRight/nocustody/.github/workflows/release.yml --source-ref refs/tags/v0.3.0 \
  --predicate-type https://spdx.dev/Document/v2.3 --format json --jq '.[0].verificationResult.statement.predicate'
```

The first command proves the image was built by the release workflow of this repository from that tag; the second
prints the verified SBOM. Builds are reproducible: you can also rebuild the tag and compare digests
([releasing.md](releasing.md#reproducing-a-release-build)).

`gh` reports success with exit code 0; when its output is not a terminal it prints nothing.

### When Sigstore is unreachable

`gh` downloads the Sigstore trusted root from `tuf-repo-cdn.sigstore.dev` before verifying. If that host is blocked
on your network, verification fails with `public good verifier is not available`. The signatures and the
transparency log proofs are inside the attestations, so the check can run offline with the trusted root that Sigstore
publishes in its [root-signing](https://github.com/sigstore/root-signing) repository:

```bash
curl -fsSL https://raw.githubusercontent.com/sigstore/root-signing/main/targets/trusted_root.json | jq -c . > trusted_root.jsonl
gh attestation verify oci://$IMAGE --repo ProofOfRight/nocustody \
  --signer-workflow ProofOfRight/nocustody/.github/workflows/release.yml --source-ref refs/tags/v0.3.0 \
  --custom-trusted-root trusted_root.jsonl
```

Add `--custom-trusted-root trusted_root.jsonl` to the SBOM command the same way. A file fetched like this is not
checked through Sigstore's TUF metadata: you rely on GitHub serving the `sigstore/root-signing` repository. Fetch a
fresh copy for each verification, since the trusted root changes when Sigstore rotates keys.

## First start

1. Copy `deploy/compose.yaml`, `deploy/db-roles.sql` and `deploy/.env.example` into a directory on the server,
   rename the last one to `.env` and `chmod 600 .env`.
2. Write `config.json` next to it. Start from [examples/](../examples/) and the [configuration reference](configuration.md).
   Inside the container the API must listen on all interfaces: `"api": { "host": "0.0.0.0" }`; compose publishes it
   on the host's loopback only. The file contains no secrets (only names of environment variables) and must be
   readable by UID 65532: `chmod 644 config.json`.
3. Fill in `.env`: the image digest, `POSTGRES_PASSWORD` and `NOCUSTODY_DB_PASSWORD` (`openssl rand -hex 32` each)
   and every variable that `config.json` refers to by name (`apiKeyEnv`, `secretEnv`, `botTokenEnv`).
4. Pin the addresses and contracts. Check every address in `config.json` against the wallet itself (not against a
   chat or e-mail), then compute the checksum and put it into `.env` as `NOCUSTODY_PINNED_SHA256`:

   ```bash
   docker compose run --rm --no-deps migrate config:hash
   ```

5. Start. The `migrate` service applies migrations and exits, `db-roles` creates the gateway's database role and
   grants it the tables ([database roles](#database-roles)); the gateway starts after both succeed:

   ```bash
   docker compose up -d --wait
   ```

6. Create an API key for the merchant application (shown once, only its hash is stored):

   ```bash
   docker compose run --rm migrate apikey:create --name shop --scopes invoices:read,invoices:write,quotes:read
   ```

The `migrate` service is the same image with the CLI as entrypoint; any CLI command can be run through it
(`ops:status`, `apikey:list`, `webhook:retry-dead`, `invoice:show <id>`, …). See [src/app/cli.ts](../src/app/cli.ts).

The gateway refuses to start when the startup checks fail (pinned checksum, TON jetton-wallet binding). While it
runs, the pinned parts of `config.json` (addresses, contracts, providers, amount policies, pricing, AML, depeg,
webhook URL — [ADR-0031](adr/0031-pinned-config-scope.md)) are re-read before every invoice and once a minute by
the monitor: a change blocks new invoices and raises the `address_pin_violation` alert. Operational settings
(timeouts, intervals, limits) are not pinned, but still need a restart to take effect. After changing a pinned
setting, compute the new checksum, update `.env` and recreate the containers (`docker compose up -d`). Many editors
replace a file instead of rewriting it; a bind-mounted file then keeps showing the old content inside the container
until it is recreated.

## TLS and exposure

The API speaks plain HTTP and must be published through a TLS reverse proxy (nginx, Caddy, Traefik):

- `/v1/*` — for the merchant backend only; restrict by source address where possible;
- `/pay/*` — for payers, only if the [payment page](payment-page.md) is enabled. **Rate-limit it per client address
  at the proxy** (nginx `limit_req`, Caddy `rate_limit`): the gateway's own limit for these routes is one bucket
  shared by everybody behind the proxy, so one client could otherwise starve all payers of the page
  ([payment-page.md](payment-page.md#security));
- `/health` — for local monitoring; there is no need to publish it.

The proxy must not cache responses; the gateway sends `cache-control: no-store`.

## What the example compose file enforces

| Setting | Why |
|---|---|
| `read_only: true`, `tmpfs: /tmp` | nothing in the container can be modified at runtime |
| `user: 65532:65532`, `cap_drop: [ALL]`, `no-new-privileges` | no root, no capabilities, no privilege escalation |
| `pids_limit`, `mem_limit` (gateway and PostgreSQL) | a bug or a flood cannot exhaust the host |
| PostgreSQL with `cap_drop: [ALL]` plus the five capabilities its entrypoint needs, `no-new-privileges` | the database container is hardened like the gateway |
| API published on `127.0.0.1` | only the reverse proxy reaches it |
| internal network `db`; `migrate` and `db-roles` on `db` only | PostgreSQL is not reachable from outside and has no internet access; migrations need no egress |
| config mounted `:ro` | the gateway cannot change its own addresses |
| gateway connects as `nocustody_app`, the owner password is blanked in its environment | code execution in the gateway cannot change the schema or rewrite payment history ([database roles](#database-roles)) |

What the compose file cannot do for you:

- **Egress.** The gateway must reach its providers, so `egress` is an ordinary bridge network. On a cloud host,
  block the instance metadata endpoint (`169.254.169.254`) from containers, or require IMDSv2 with a hop limit of 1;
  otherwise code execution inside the container could read instance credentials.
- **Who may change the pin.** `NOCUSTODY_PINNED_SHA256` lives in `.env`. If the same user can edit `config.json` and
  `.env`, the pin only catches mistakes, not an attacker on the host. Where possible give `.env` a different owner
  (root, mode 600) than the account that edits `config.json`, or deliver the pin as a compose `secrets:` file; the
  address canary on another host remains the control against a compromised host.
- **A backup holds secrets.** `pg_dump` contains API key hashes, idempotency keys, webhook payloads and payer
  addresses; protect dumps like the server. The webhook secret and provider keys are only in `.env`.

## Database roles

Two PostgreSQL roles:

- `nocustody` — the owner (a superuser in the official image). Used by `migrate` and by CLI commands run through
  it. Its password, `POSTGRES_PASSWORD`, is blanked in the gateway's environment.
- `nocustody_app` — the gateway at runtime: no superuser, no `CREATEDB`/`CREATEROLE`, no DDL; reads and writes
  rows, but cannot `UPDATE` or `DELETE` `audit_log` and `invoice_payments` or `DELETE` `observed_transfers` (the
  gateway updates a transfer's status when it settles). Code execution in the gateway therefore cannot drop tables
  or erase the record of what was credited.

`db-roles` runs [deploy/db-roles.sql](../deploy/db-roles.sql) as the owner after every migration; it is idempotent,
so tables added by an upgrade get the same grants. To rotate `NOCUSTODY_DB_PASSWORD`, change it in `.env` and run
`docker compose up -d`. An existing deployment that connected as the owner switches on its next
`docker compose up -d` once `NOCUSTODY_DB_PASSWORD` is set and `db-roles.sql` is next to `compose.yaml`.

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
