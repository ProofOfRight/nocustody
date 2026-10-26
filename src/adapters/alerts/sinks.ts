// SPDX-License-Identifier: Apache-2.0
// Alert sinks: structured log (always), Telegram send-only bot (optional), and a de-duplicating wrapper.
import type { Alert, AlertSink } from "../../application/ports.ts";

export class LogAlertSink implements AlertSink {
  readonly #log: (level: "info" | "warn" | "error", fields: object, msg: string) => void;

  constructor(log: (level: "info" | "warn" | "error", fields: object, msg: string) => void) {
    this.#log = log;
  }

  async send(a: Alert): Promise<void> {
    this.#log(
      a.severity === "critical" ? "error" : a.severity === "warning" ? "warn" : "info",
      { alert: a.key },
      a.message,
    );
  }
}

/**
 * Telegram Bot API sendMessage, send-only (the bot never reads updates, so nobody can command it).
 * The bot token is part of the URL; errors are reported without the URL so the token never reaches logs.
 */
export class TelegramAlertSink implements AlertSink {
  readonly #token: string;
  readonly #chatId: string;
  readonly #timeoutMs: number;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;

  constructor(o: {
    token: string;
    chatId: string;
    timeoutMs: number;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  }) {
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(o.token))
      throw new Error("Telegram bot token has an unexpected format");
    this.#token = o.token;
    this.#chatId = o.chatId;
    this.#timeoutMs = o.timeoutMs;
    this.#fetch = o.fetch ?? ((u, i) => fetch(u, i));
  }

  async send(a: Alert): Promise<void> {
    const icon = a.severity === "critical" ? "🔴" : a.severity === "warning" ? "🟠" : "🟢";
    let res: Response;
    try {
      res = await this.#fetch(`https://api.telegram.org/bot${this.#token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.#chatId,
          text: `${icon} nocustody: ${a.message}`.slice(0, 4000),
          disable_web_page_preview: true,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new Error(`telegram: request failed (${e instanceof Error ? e.name : "error"})`);
    }
    await res.body?.cancel();
    if (!res.ok) throw new Error(`telegram: HTTP ${res.status}`);
  }
}

/**
 * Sends to every sink; repeats of the same key within the cooldown are dropped; a failing sink does not stop others.
 * The cooldown lives in this process: two monitor processes each send their own copy of an alert.
 */
export class AlertRouter implements AlertSink {
  readonly #sinks: readonly AlertSink[];
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #last = new Map<string, number>();
  readonly #onFailure: (err: unknown) => void;

  constructor(
    sinks: readonly AlertSink[],
    cooldownMs: number,
    onFailure: (err: unknown) => void,
    now: () => number = Date.now,
  ) {
    this.#sinks = sinks;
    this.#cooldownMs = cooldownMs;
    this.#onFailure = onFailure;
    this.#now = now;
  }

  /** Keys still inside their cooldown (for tests: the map must not grow with uptime). */
  get tracked(): number {
    return this.#last.size;
  }

  async send(a: Alert): Promise<void> {
    const t = this.#now();
    const prev = this.#last.get(a.key);
    if (prev !== undefined && t - prev < this.#cooldownMs) return;
    // Keys like never-final:<tx> are unique per condition: forget the expired ones so memory stays flat for months.
    for (const [key, at] of this.#last) if (t - at >= this.#cooldownMs) this.#last.delete(key);
    this.#last.set(a.key, t);
    await Promise.all(this.#sinks.map((s) => s.send(a).catch((e: unknown) => this.#onFailure(e))));
  }
}
