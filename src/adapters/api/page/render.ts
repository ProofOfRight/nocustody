// SPDX-License-Identifier: Apache-2.0
// Hosted payment page: one HTML document, inline CSS and JS only (no external resources, ADR-0027), strict CSP with
// a per-response nonce. Every dynamic value is HTML-escaped; data for the script is embedded as escaped JSON.
import { isRtl, LANGUAGES, type Lang, MESSAGES, type Messages } from "./i18n.ts";
import { qrSvg } from "./qr.ts";

export interface PageView {
  readonly id: string;
  readonly status: string;
  readonly assetSymbol: string;
  readonly networkName: string;
  readonly amount: string;
  /** Null when the address may not be shown (retired or not pinned, ADR-0037); `payable` is then false. */
  readonly address: string | null;
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
  /** The invoice could still be paid, but its address was withdrawn: tell the payer not to send funds. */
  readonly addressWithdrawn?: boolean;
  /**
   * The merchant's return URLs, already checked against the configured origins (null = no button). Shown as a link,
   * never followed automatically: success once the payment is received, cancel otherwise.
   */
  readonly successUrl?: string | null;
  readonly cancelUrl?: string | null;
}

const PAYABLE_STATUSES = new Set(["awaiting_payment", "confirming", "underpaid", "expired"]);
/** The payment is in and nothing more is needed from the payer; the same set as `OK` in the page script. */
const RECEIVED_STATUSES = new Set(["paid", "overpaid", "paid_late", "completed", "aml_pending"]);

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

// Light theme only. Inter is used when installed locally; no web fonts are loaded (ADR-0027).
const CSS = `
:root{color-scheme:light;--ink:#0f1a14;--ink-2:#3d4c44;--ink-3:#4a5a52;--brand:#0b7a50;--brand-ink:#0b6b47;--brand-ink-hover:#08523a;
--brand-tint:#e6f4ec;--selected:#eef6f1;--secondary-line:#b9d3c5;--line:#dce5e0;--field:#c5d3cb;--page:#f4f7f5;--inner:#fbfcfb;
--warn-bg:#fff6e0;--warn-ink:#6b4300;--warn-line:#f1dfae;--danger:#b42318;--danger-line:#f3c7c2;--ring:0 0 0 3px rgba(11,122,80,.35)}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Tahoma,sans-serif;color:var(--ink);background:var(--page)}
main{max-width:34rem;margin:0 auto;padding:40px 20px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:16px}
h1{font-size:20px;line-height:1.3;font-weight:700;margin:0}.card>p{margin:0}
.muted{color:var(--ink-3);font-size:13px;line-height:1.45}
.total{background:var(--page);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.amount-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.amount{font-size:28px;line-height:1.25;font-weight:700}
.field{display:flex;flex-direction:column;gap:6px}.label{font-size:13px;color:var(--ink-3)}
.box{display:flex;align-items:center;gap:8px;padding:6px;padding-inline-start:12px;border-radius:10px;border:1px solid var(--line);background:var(--inner);min-height:52px}
.box>.value{flex:1;min-width:0}
.value{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;word-break:break-all;direction:ltr;unicode-bidi:embed;text-align:start}
.amount .value{font-size:inherit}
button,.btn{font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;border-radius:10px}
button{flex:none;min-height:40px;padding:0 12px;font-size:14px;border:1px solid var(--secondary-line);background:#fff;color:var(--brand-ink)}
button:hover{background:var(--selected);border-color:var(--brand)}button.done{background:var(--selected);border-color:var(--brand)}
.btn{min-height:48px;padding:0 20px;border-radius:12px;border:1px solid var(--brand);background:var(--brand);color:#fff;width:100%}
.btn:hover{background:var(--brand-ink);border-color:var(--brand-ink)}
a{color:var(--brand-ink)}a:hover{color:var(--brand-ink-hover)}
:focus-visible{outline:none;box-shadow:var(--ring)}
.qr{display:block;width:14rem;max-width:80%;margin:0 auto;background:#fff;padding:8px;border:1px solid var(--line);border-radius:12px}
.status,.warning{margin:0;padding:14px 16px;border-radius:12px;font-size:14px;border:1px solid var(--line);background:var(--page);color:var(--ink-2)}
.status{font-weight:600}
.status.ok{background:var(--brand-tint);border-color:var(--secondary-line);color:var(--brand-ink)}
.status.warn,.warning{background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn-ink)}
.status.err{background:#fff;border-color:var(--danger-line);color:var(--danger)}
.back{align-self:center;display:inline-flex;align-items:center;min-height:44px;padding:0 12px;font-size:14px;font-weight:500}
[hidden]{display:none!important}
nav{margin-top:16px;display:flex;flex-wrap:wrap;gap:4px;justify-content:center}
nav a{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border-radius:10px;font-size:14px;font-weight:500;text-decoration:none}
nav a:hover{background:#fff}nav a[aria-current]{color:var(--ink);font-weight:700}
@media (max-width:480px){main{padding:16px}.card{padding:18px}.btn{min-height:44px}}
`;

const SCRIPT = `
(function(){
  var d = JSON.parse(document.getElementById("page-data").textContent);
  var statusEl = document.getElementById("status"), timerEl = document.getElementById("timer");
  var hintEl = document.getElementById("done-hint");
  var successEl = document.getElementById("back-success"), cancelEl = document.getElementById("back-cancel");
  // Stop polling on a final status, or once the grace period is over (an expired invoice stays "expired" forever).
  // "underpaid" is not final: a top-up with the same memo completes the invoice.
  var FINAL = {paid:1,overpaid:1,paid_late:1,completed:1,aml_pending:1,aml_hold:1,rejected:1,cancelled:1};
  var OK = {paid:1,overpaid:1,paid_late:1,completed:1,aml_pending:1};
  function finished(s){ return FINAL[s] || Date.now() > Date.parse(d.graceUntil); }
  function show(s){
    statusEl.textContent = d.statusText[s] || s;
    statusEl.className = "status " + (OK[s] ? "ok" : (s === "awaiting_payment" || s === "confirming") ? "" : s === "expired" ? "warn" : "err");
    hintEl.hidden = !OK[s] || !!successEl;
    if (successEl) successEl.hidden = !OK[s];
    if (cancelEl) cancelEl.hidden = !!OK[s];
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
      var done = function(){
        var t = b.textContent; b.textContent = d.copied; b.classList.add("done");
        setTimeout(function(){ b.textContent = t; b.classList.remove("done"); }, 2000);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function(){});
    });
  });
  show(d.status); tick(); setInterval(tick, 1000);
  var handle = setInterval(poll, 10000);
  if (finished(d.status)) clearInterval(handle);
})();
`;

const statusText = (t: Messages, status: string): string =>
  (t.status as Readonly<Record<string, string>>)[status] ?? status;

export function renderPaymentPage(v: PageView, lang: Lang, nonce: string): string {
  const t = MESSAGES[lang];
  const qrPayload = v.uri ?? v.address ?? "";
  const received = RECEIVED_STATUSES.has(v.status);
  const only = t.onlyAsset.replace("{asset}", esc(v.assetSymbol)).replace("{network}", esc(v.networkName));
  const field = (id: string, label: string, value: string) =>
    `<div class="field"><div class="label">${esc(label)}</div><div class="box"><div class="value" id="${id}">${esc(value)}</div>` +
    `<button type="button" data-copy="${id}" aria-live="polite">${esc(t.copy)}</button></div></div>`;
  const langs = LANGUAGES.map(
    (l) =>
      `<a href="?lang=${encodeURIComponent(l)}" hreflang="${l}"${l === lang ? ' aria-current="true"' : ""}>${esc(l)}</a>`,
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
<div class="card">
<h1>${esc(t.title)}</h1>
${
  v.payable && v.address !== null
    ? `<div class="total">
<div class="muted">${esc(t.send)}</div>
<div class="amount-row"><div class="amount"><span id="amount" class="value">${esc(v.amount)}</span> ${esc(v.assetSymbol)}</div>
<button type="button" data-copy="amount" aria-live="polite">${esc(t.copy)}</button></div>
<div class="muted">${esc(t.exactly)}</div>
</div>
<p class="warning">${only}</p>
<div class="field"><div class="label">${esc(t.network)}</div><div>${esc(v.networkName)}</div></div>
${field("address", t.toAddress, v.address ?? "")}
${v.memo ? `${field("memo", t.memo, v.memo)}<p class="warning">${esc(t.memoWarning)}</p>` : ""}
<div class="qr">${qrSvg(qrPayload, esc(t.qr))}</div>
${v.uri ? `<a class="btn" href="${esc(v.uri)}" rel="noopener noreferrer">${esc(t.openWallet)}</a>` : ""}`
    : ""
}
${v.addressWithdrawn ? `<p class="warning">${esc(t.addressWithdrawn)}</p>` : ""}
<div class="status" id="status" role="status" aria-live="polite">${esc(statusText(t, v.status))}</div>
<p class="muted" id="done-hint"${received && !v.successUrl ? "" : " hidden"}>${esc(t.doneHint)}</p>
${v.successUrl ? `<a class="btn" id="back-success" href="${esc(v.successUrl)}" rel="noopener noreferrer"${received ? "" : " hidden"}>${esc(t.backToMerchant)}</a>` : ""}
${v.payable ? `<div class="muted">${esc(t.timeLeft)}: <span id="timer" class="value"></span></div>` : ""}
${v.cancelUrl ? `<a class="back" id="back-cancel" href="${esc(v.cancelUrl)}" rel="noopener noreferrer"${received ? " hidden" : ""}>${esc(t.backToMerchant)}</a>` : ""}
</div>
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
