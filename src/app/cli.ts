// SPDX-License-Identifier: Apache-2.0
// Command line entry point. Stage 2 has no HTTP API yet; invoices can be created from the CLI.
//   node src/app/cli.ts config:hash            print the pinned checksum to set as NOCUSTODY_PINNED_SHA256
//   node src/app/cli.ts db:migrate             apply database migrations
//   node src/app/cli.ts invoice:create --order <id> --amount <decimal> --currency <code> --asset <id>
//   node src/app/cli.ts invoice:show <id>
//   node src/app/cli.ts run                    scanner + verifier + settlement loop
import { parseArgs } from "node:util";
import pg from "pg";
import { migrate } from "../adapters/persistence/pg/migrate.ts";
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
    case "run": {
      const { container } = await start();
      const interval = Math.min(...container.workers.map((w) => w.pollIntervalMs));
      let stopping = false;
      const stop = () => {
        stopping = true;
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      logger.info({ networks: container.workers.map((w) => w.adapter.network), interval }, "worker started");
      while (!stopping) {
        try {
          logger.info(await runCycle(container), "cycle");
        } catch (e) {
          // A failing provider or database must not crash the loop; the next cycle retries.
          logger.error({ err: e }, "cycle failed");
        }
        await new Promise((r) => setTimeout(r, interval));
      }
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
