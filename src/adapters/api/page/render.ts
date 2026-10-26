// SPDX-License-Identifier: Apache-2.0
// Hosted payment page: one HTML document, inline CSS and JS only (no external resources, ADR-0027), strict CSP with
// a per-response nonce. Every dynamic value is HTML-escaped; data for the script is embedded as escaped JSON.
import { isRtl, LANGUAGES, type Lang, MESSAGES } from "./i18n.ts";
import { qrSvg } from "./qr.ts";

export interface PageView {
  readonly id: string;
  readonly status: string;
  readonly assetSymbol: string;
  readonly networkName: string;
  readonly amount: string;
  readonly address: string;
  readonly memo: string | null;
  readonly uri: string | null;
  readonly expiresAt: string;
  readonly graceUntil: string;
  readonly statusUrl: string;
  /**
   * Whether a payment sent now can still be credited to this invoice. When false the page shows the status only:
   * after `graceUntil` the (address, amount) pair may belong to a newer invoice, so a payer who follows an old link
   * must not see an address, amount or QR code to pay.
   */
  readonly payable: boolean;
}

const PAYABLE_STATUSES = new Set(["awaiting_payment", "confirming", "underpaid", "expired"]);

/** The server-side half of `PageView.payable`: payable status and still inside the grace period. */
export function isPayable(status: string, graceUntil: Date, now: Date): boolean {
  return PAYABLE_STATUSES.has(status) && now.getTime() <= graceUntil.getTime();
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
/** JSON safe to embed in <script type="application/json">. */
const jsonForHtml = (v: unknown) =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

export const NETWORK_NAMES: Readonly<Record<string, string>> = {
  "tron:mainnet": "TRON (TRC-20)",
  "tron:nile": "TRON Nile testnet",
  "tron:shasta": "TRON Shasta testnet",
  "ton:mainnet": "TON",
  "ton:testnet": "TON testnet",
};

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const CSS = `
:root{color-scheme:light dark;--fg:#111;--bg:#fff;--muted:#666;--box:#f4f4f5;--ok:#15803d;--warn:#b45309;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#18181b;--muted:#a1a1aa;--box:#27272a}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Tahoma,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:30rem;margin:0 auto;padding:1.25rem}h1{font-size:1.25rem;margin:0 0 1rem}
.amount{font-size:1.75rem;font-weight:700;margin:.25rem 0}.muted{color:var(--muted);font-size:.875rem}
.field{background:var(--box);border-radius:.5rem;padding:.75rem;margin:.75rem 0}.label{font-size:.8rem;color:var(--muted)}
.value{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;direction:ltr;unicode-bidi:embed;text-align:start}
button,.btn{font:inherit;border:1px solid var(--muted);background:transparent;color:inherit;border-radius:.375rem;padding:.3rem .75rem;margin-top:.4rem;cursor:pointer;text-decoration:none;display:inline-block}
.qr{display:block;width:14rem;max-width:80%;margin:1rem auto;background:#fff;padding:.25rem;border-radius:.25rem}
.status{font-weight:600;margin:1rem 0;padding:.75rem;border-radius:.5rem;background:var(--box)}
.status.ok{color:var(--ok)}.status.warn{color:var(--warn)}.status.err{color:var(--err)}
.warning{color:var(--warn);font-size:.875rem}nav{margin-top:1.5rem;font-size:.8rem}nav a{color:var(--muted);margin-inline-end:.75rem}
`;

const SCRIPT = `
(function(){
  var d = JSON.parse(document.getElementById("page-data").textContent);
  var statusEl = document.getElementById("status"), timerEl = document.getElementById("timer");
  // Stop polling on a final status, or once the grace period is over (an expired invoice stays "expired" forever).
  // "underpaid" is not final: a top-up with the same memo completes the invoice.
  var FINAL = {paid:1,overpaid:1,paid_late:1,completed:1,aml_pending:1,aml_hold:1,rejected:1,cancelled:1};
  var OK = {paid:1,overpaid:1,paid_late:1,completed:1,aml_pending:1};
  function finished(s){ return FINAL[s] || Date.now() > Date.parse(d.graceUntil); }
  function show(s){
    statusEl.textContent = d.statusText[s] || s;
    statusEl.className = "status " + (OK[s] ? "ok" : (s === "awaiting_payment" || s === "confirming") ? "" : s === "expired" ? "warn" : "err");
  }
  function tick(){
    if (!timerEl) return;
    var left = Math.max(0, Math.floor((Date.parse(d.expiresAt) - Date.now()) / 1000));
    timerEl.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  }
  var poll = function(){
    fetch(d.statusUrl, {cache: "no-store", credentials: "omit"}).then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ if (!j) return; d.status = j.status; show(j.status); if (finished(j.status)) clearInterval(handle); })
      .catch(function(){});
  };
  document.querySelectorAll("button[data-copy]").forEach(function(b){
    b.addEventListener("click", function(){
      var text = document.getElementById(b.getAttribute("data-copy")).textContent;
      var done = function(){ var t = b.textContent; b.textContent = d.copied; setTimeout(function(){ b.textContent = t; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function(){});
    });
  });
  show(d.status); tick(); setInterval(tick, 1000);
  var handle = setInterval(poll, 10000);
  if (finished(d.status)) clearInterval(handle);
})();
`;

export function renderPaymentPage(v: PageView, lang: Lang, nonce: string): string {
  const t = MESSAGES[lang];
  const qrPayload = v.uri ?? v.address;
  const only = t.onlyAsset.replace("{asset}", esc(v.assetSymbol)).replace("{network}", esc(v.networkName));
  const field = (id: string, label: string, value: string) =>
    `<div class="field"><div class="label">${esc(label)}</div><div class="value" id="${id}">${esc(value)}</div>` +
    `<button type="button" data-copy="${id}">${esc(t.copy)}</button></div>`;
  const langs = LANGUAGES.map(
    (l) => `<a href="?lang=${encodeURIComponent(l)}" hreflang="${l}">${esc(l)}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="${lang}" dir="${isRtl(lang) ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow">
<title>${esc(t.title)} — ${esc(v.amount)} ${esc(v.assetSymbol)}</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
<h1>${esc(t.title)}</h1>
${
  v.payable
    ? `<div class="muted">${esc(t.send)}</div>
<div class="amount"><span id="amount" class="value">${esc(v.amount)}</span> ${esc(v.assetSymbol)}</div>
<button type="button" data-copy="amount">${esc(t.copy)}</button>
<p class="muted">${esc(t.exactly)}</p>
<p class="warning">${only}</p>
<div class="field"><div class="label">${esc(t.network)}</div><div>${esc(v.networkName)}</div></div>
${field("address", t.toAddress, v.address)}
${v.memo ? `${field("memo", t.memo, v.memo)}<p class="warning">${esc(t.memoWarning)}</p>` : ""}
<div class="qr">${qrSvg(qrPayload, esc(t.qr))}</div>
${v.uri ? `<p><a class="btn" href="${esc(v.uri)}" rel="noopener noreferrer">${esc(t.openWallet)}</a></p>` : ""}`
    : ""
}
<div class="status" id="status" role="status" aria-live="polite">${esc(t.status[v.status] ?? v.status)}</div>
${v.payable ? `<div class="muted">${esc(t.timeLeft)}: <span id="timer" class="value"></span></div>` : ""}
<nav>${langs}</nav>
</main>
<script type="application/json" id="page-data">${jsonForHtml({
    status: v.status,
    expiresAt: v.expiresAt,
    graceUntil: v.graceUntil,
    statusUrl: v.statusUrl,
    statusText: t.status,
    copied: t.copied,
  })}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
