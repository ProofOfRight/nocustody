// SPDX-License-Identifier: Apache-2.0
// Command line entry point. Stage 2 has no HTTP API yet; invoices can be created from the CLI.
//   node src/app/cli.ts config:hash            print the pinned checksum to set as NOCUSTODY_PINNED_SHA256
//   node src/app/cli.ts db:migrate             apply database migrations
//   node src/app/cli.ts invoice:create --order <id> --amount <decimal> --currency <code> --asset <id>
//   node src/app/cli.ts invoice:show <id>
//   node src/app/cli.ts apikey:create --name <name> --scopes invoices:read,invoices:write,quotes:read
//   node src/app/cli.ts apikey:list | apikey:revoke <id>
//   node src/app/cli.ts ops:status                            heartbeats, guards, queues needing attention
//   node src/app/cli.ts webhook:retry-dead [event-id]         put dead-lettered webhooks back into delivery
//   node src/app/cli.ts invoice:aml-resolve <id> approve|reject --note <text>
//   node src/app/cli.ts run [--roles api,worker,dispatcher,monitor]   (default: all four)
import { parseArgs } from "node:util";
import pg from "pg";
import { ALL_SCOPES, newApiKey } from "../adapters/api/keys.ts";
import { migrate } from "../adapters/persistence/pg/migrate.ts";
import type { ApiScope } from "../application/ports.ts";
import { assertPinned, type Config, loadConfigFile } from "./config.ts";
import { addressValidators, buildContainer, type Container, runCycle } from "./container.ts";
import { ConfigFilePinGuard } from "./integrity.ts";
import { logger } from "./logger.ts";

function configPath(): string {
  const p = process.env.NOCUSTODY_CONFIG;
  if (!p) throw new Error("NOCUSTODY_CONFIG (path to the JSON config) is not set");
  return p;
}

function databaseUrl(config: Config): string {
  const url = process.env[config.raw.database.urlEnv];
  if (!url) throw new Error(`${config.raw.database.urlEnv} is not set`);
  return url;
}

async function start(): Promise<{ config: Config; container: Container }> {
  const path = configPath();
  const config = loadConfigFile(path, addressValidators);
  const expected = process.env.NOCUSTODY_PINNED_SHA256;
  assertPinned(config, expected);
  const integrity = new ConfigFilePinGuard(path, expected as string, addressValidators, (reason) =>
    logger.error(
      { alert: "address_pin_violation", reason },
      "pinned config changed: new invoices are blocked",
    ),
  );
  const container = buildContainer({ config, databaseUrl: databaseUrl(config), integrity });
  try {
    await container.verifyStartup();
  } catch (e) {
    await container.pool.end();
    throw e;
  }
  return { config, container };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "config:hash": {
      console.log(loadConfigFile(configPath(), addressValidators).pinnedChecksum);
      return;
    }
    case "db:migrate": {
      const config = loadConfigFile(configPath(), addressValidators);
      const pool = new pg.Pool({ connectionString: databaseUrl(config) });
      try {
        logger.info(await migrate(pool), "migrations");
      } finally {
        await pool.end();
      }
      return;
    }
    case "invoice:create": {
      const { values } = parseArgs({
        args: rest,
        options: {
          order: { type: "string" },
          amount: { type: "string" },
          currency: { type: "string" },
          asset: { type: "string" },
        },
      });
      if (!values.order || !values.amount || !values.currency || !values.asset) {
        throw new Error(
          "usage: invoice:create --order <id> --amount <decimal> --currency <code> --asset <id>",
        );
      }
      const { container } = await start();
      try {
        const { invoice, created } = await container.createInvoice.execute({
          merchantOrderId: values.order,
          priceAmount: values.amount,
          priceCurrency: values.currency,
          assetId: values.asset,
        });
        const s = invoice.state;
        console.log(
          JSON.stringify(
            {
              created,
              id: s.id,
              status: s.status,
              payTo: s.instructions.address.value,
              amount: s.instructions.amount.toDecimalString(),
              asset: s.asset.id,
              expiresAt: s.expiresAt,
              graceUntil: s.graceUntil,
              price: s.price,
            },
            null,
            2,
          ),
        );
      } finally {
        await container.pool.end();
      }
      return;
    }
    case "invoice:show": {
      const id = rest[0];
      if (!id) throw new Error("usage: invoice:show <id>");
      const { container } = await start();
      try {
        const inv = await container.uow.run((r) => r.invoices.findById(id));
        if (!inv) throw new Error(`invoice ${id} not found`);
        const events = await container.pool.query(
          "SELECT event_id, type, occurred_at, payload FROM outbox WHERE aggregate_id = $1 ORDER BY id",
          [id],
        );
        const s = inv.state;
        console.log(
          JSON.stringify(
            {
              id: s.id,
              status: s.status,
              received: inv.received().toDecimalString(),
              payments: s.payments.map((p) => ({ ...p, amount: p.amount.toDecimalString() })),
              outbox: events.rows,
            },
            null,
            2,
          ),
        );
      } finally {
        await container.pool.end();
      }
      return;
    }
    case "apikey:create": {
      const { values } = parseArgs({
        args: rest,
        options: { name: { type: "string" }, scopes: { type: "string" } },
      });
      const scopes = (values.scopes ?? ALL_SCOPES.join(",")).split(",").map((x) => x.trim()) as ApiScope[];
      const { record, token } = newApiKey(values.name ?? "default", scopes);
      const { container } = await start();
      try {
        await container.uow.run((r) => r.apiKeys.insert(record));
      } finally {
        await container.pool.end();
      }
      // Shown once; only its hash is stored.
      console.log(
        JSON.stringify({ id: record.id, name: record.name, scopes: record.scopes, token }, null, 2),
      );
      return;
    }
    case "apikey:list": {
      const { container } = await start();
      try {
        const keys = await container.uow.run((r) => r.apiKeys.list());
        console.log(
          JSON.stringify(
            keys.map((k) => ({ id: k.id, name: k.name, scopes: k.scopes, revokedAt: k.revokedAt })),
            null,
            2,
          ),
        );
      } finally {
        await container.pool.end();
      }
      return;
    }
    case "apikey:revoke": {
      const id = rest[0];
      if (!id) throw new Error("usage: apikey:revoke <id>");
      const { container } = await start();
      try {
        const done = await container.uow.run((r) => r.apiKeys.revoke(id, new Date()));
        console.log(done ? `revoked ${id}` : `no active key ${id}`);
      } finally {
        await container.pool.end();
      }
      return;
    }
    case "ops:status": {
      const { container } = await start();
      try {
        const q = async (sql: string) => (await container.pool.query<{ k: string; n: number }>(sql)).rows;
        const status = {
          heartbeats: await container.uow.run((r) => r.heartbeats.list()),
          guards: (
            await container.pool.query("SELECT key, blocked, reason, updated_at FROM guards ORDER BY key")
          ).rows,
          invoices: await q(
            "SELECT status AS k, count(*)::int AS n FROM invoices WHERE status IN ('underpaid','overpaid','paid_late','aml_pending','aml_hold') GROUP BY status",
          ),
          transfers: await q(
            "SELECT status AS k, count(*)::int AS n FROM observed_transfers WHERE status = 'unmatched' GROUP BY status",
          ),
          candidates: await q(
            "SELECT status AS k, count(*)::int AS n FROM tx_candidates WHERE status = 'seen' GROUP BY status",
          ),
          webhooks: await q(
            "SELECT CASE WHEN dead_at IS NOT NULL THEN 'dead' ELSE 'pending' END AS k, count(*)::int AS n FROM outbox WHERE delivered_at IS NULL GROUP BY 1",
          ),
        };
        console.log(JSON.stringify(status, null, 2));
      } finally {
        await container.pool.end();
      }
      return;
    }
    case "webhook:retry-dead": {
      const { container } = await start();
      try {
        const n = await container.uow.run((r) => r.delivery.reviveDead(new Date(), rest[0]));
        console.log(`${n} event(s) put back into delivery`);
      } finally {
        await container.pool.end();
      }
      return;
    }
    case "invoice:aml-resolve": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { note: { type: "string" } },
      });
      const [id, decision] = positionals;
      if (!id || (decision !== "approve" && decision !== "reject") || !values.note) {
        throw new Error("usage: invoice:aml-resolve <id> approve|reject --note <text>");
      }
      const { container } = await start();
      try {
        console.log(
          `invoice ${id}: ${await container.resolveAmlHold.execute(id, decision === "approve", values.note)}`,
        );
      } finally {
        await container.pool.end();
      }
      return;
    }
    case "run": {
      const { values } = parseArgs({ args: rest, options: { roles: { type: "string" } } });
      const roles = new Set(
        (values.roles ?? "api,worker,dispatcher,monitor").split(",").map((x) => x.trim()),
      );
      for (const r of roles)
        if (!["api", "worker", "dispatcher", "monitor"].includes(r)) throw new Error(`unknown role ${r}`);
      const { config, container } = await start();
      let stopping = false;
      const loops: Promise<void>[] = [];
      const loop = (name: string, intervalMs: number, step: () => Promise<unknown>) =>
        loops.push(
          (async () => {
            while (!stopping) {
              try {
                const result = await step();
                logger.debug({ role: name, result }, "cycle");
              } catch (e) {
                // A failing provider, endpoint or database must not crash the loop; the next cycle retries.
                logger.error({ role: name, err: e }, "cycle failed");
              }
              await new Promise((r) => setTimeout(r, intervalMs));
            }
          })(),
        );
      let api: ReturnType<Container["api"]> | null = null;
      if (roles.has("api")) {
        api = container.api((err) => logger.error({ err }, "api error"));
        await api.listen(config.raw.api.host, config.raw.api.port);
        logger.info({ host: config.raw.api.host, port: config.raw.api.port }, "api listening");
      }
      if (roles.has("worker")) {
        const interval = Math.min(...container.workers.map((w) => w.pollIntervalMs));
        loop("worker", interval, () => runCycle(container));
      }
      if (roles.has("dispatcher")) {
        const dispatcher = container.dispatcher;
        if (!dispatcher) logger.warn("dispatcher role requested but no webhooks are configured");
        else loop("dispatcher", 2_000, () => dispatcher.execute());
      }
      if (roles.has("monitor")) {
        const { healthMs, reconcileMs, depegMs } = container.monitorIntervals;
        loop("monitor:health", healthMs, () => container.monitor.checkHealth());
        if (reconcileMs) loop("monitor:reconcile", reconcileMs, () => container.monitor.reconcile());
        if (depegMs) loop("monitor:depeg", depegMs, () => container.monitor.checkDepeg());
      }
      const stop = () => {
        stopping = true;
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      logger.info(
        { roles: [...roles], networks: container.workers.map((w) => w.adapter.network) },
        "started",
      );
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (stopping) {
            clearInterval(t);
            resolve();
          }
        }, 200);
      });
      await api?.close();
      await Promise.all(loops);
      await container.pool.end();
      return;
    }
    default:
      throw new Error(`unknown command ${command ?? ""}; see the header of src/app/cli.ts`);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  logger.error({ err: e }, e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
