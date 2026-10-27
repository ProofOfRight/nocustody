// SPDX-License-Identifier: Apache-2.0
import jsqrImport from "jsqr";
import { describe, expect, it } from "vitest";
import { LANGUAGES, MESSAGES, pickLanguage } from "./i18n.ts";
import { qrMatrix } from "./qr.ts";
import { contentSecurityPolicy, isPayable, type PageView, renderPaymentPage } from "./render.ts";

// jsqr is a CommonJS bundle with a default export; normalise the interop shape.
type Decoder = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQR = ((jsqrImport as unknown as { default?: Decoder }).default ?? jsqrImport) as unknown as Decoder;

/** Rasterises the module matrix and decodes it with jsQR (an independent decoder). */
function decode(text: string): string | null {
  const m = qrMatrix(text);
  const scale = 4;
  const quiet = 4;
  const n = (m.size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.isDark(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + quiet) * scale + y) * n + (c + quiet) * scale + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(px, n, n)?.data ?? null;
}

const view: PageView = {
  id: "0b9e6a4e-6f2a-4c1e-9d55-1f0c6b8f1a11",
  status: "awaiting_payment",
  assetSymbol: "USDT",
  networkName: "TON",
  amount: "10.010000",
  address: "0:326bcaf1f252ca9e3458fe73348566afe805f7c5b40339277260bcb2fc8762b0",
  memo: "AB2C3D4E",
  uri: "ton://transfer/UQAya8rx8lLKnjRY_nM0hWav6AX3xbQDOSdyYLyy_IdisFZt?jetton=EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs&amount=10010000&text=AB2C3D4E",
  expiresAt: "2026-10-26T12:30:00.000Z",
  graceUntil: "2026-10-26T13:30:00.000Z",
  statusUrl: "/pay/0b9e6a4e-6f2a-4c1e-9d55-1f0c6b8f1a11/status",
  payable: true,
};

describe("QR code", () => {
  it("decodes back to exactly the encoded payment data (independent decoder)", () => {
    for (const text of ["TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq", view.uri ?? "", view.address]) {
      expect(decode(text)).toBe(text);
    }
  });

  it("refuses non-ASCII payloads", () => {
    expect(() => qrMatrix("адрес")).toThrow("ASCII");
  });
});

describe("languages", () => {
  it("query wins, then Accept-Language by q, then the default", () => {
    expect(pickLanguage("fa", "ru", "en")).toBe("fa");
    expect(pickLanguage(undefined, "de-DE,ru;q=0.8,en;q=0.9", "en")).toBe("en");
    expect(pickLanguage(undefined, "ru-RU;q=0.9,fr;q=0.5", "en")).toBe("ru");
    expect(pickLanguage(undefined, "zh-Hans-CN,zh;q=0.9", "en")).toBe("zh-CN");
    expect(pickLanguage("xx", "de", "ru")).toBe("ru");
    expect(pickLanguage(undefined, "zh-TW", "en")).toBe("en"); // traditional Chinese is not offered
  });

  it("every language has every text and every invoice status", () => {
    const keys = Object.keys(MESSAGES.en).sort();
    const statuses = Object.keys(MESSAGES.en.status).sort();
    for (const l of LANGUAGES) {
      expect(Object.keys(MESSAGES[l]).sort()).toEqual(keys);
      expect(Object.keys(MESSAGES[l].status).sort()).toEqual(statuses);
      expect(MESSAGES[l].onlyAsset).toContain("{asset}");
      expect(MESSAGES[l].onlyAsset).toContain("{network}");
    }
  });
});

describe("payment page", () => {
  it("is self-contained: no external resources, nonce on every inline style/script", () => {
    const html = renderPaymentPage(view, "en", "N0nce");
    expect(html).not.toMatch(/(src|href)=["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html.match(/<script nonce="N0nce">/g)).toHaveLength(1);
    expect(html.match(/<style nonce="N0nce">/g)).toHaveLength(1);
    expect(html.match(/<script(?! nonce="N0nce"| type="application\/json")/g)).toBeNull();
    expect(contentSecurityPolicy("N0nce")).toContain("default-src 'none'");
    expect(contentSecurityPolicy("N0nce")).toContain("frame-ancestors 'none'");
  });

  it("shows the exact amount, address, memo and wallet link", () => {
    const html = renderPaymentPage(view, "en", "n");
    expect(html).toContain(">10.010000<");
    expect(html).toContain(view.address);
    expect(html).toContain(">AB2C3D4E<");
    expect(html).toContain('href="ton://transfer/');
  });

  it("escapes everything dynamic, including inside the embedded JSON", () => {
    const evil = {
      ...view,
      memo: "<img src=x onerror=alert(1)>",
      assetSymbol: '"><script>alert(1)</script>',
      statusUrl: "/pay/x</script><script>alert(1)//",
    };
    const html = renderPaymentPage(evil, "en", "n");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("</script><script>");
  });

  it("right-to-left for Persian; language links for all languages", () => {
    expect(renderPaymentPage(view, "fa", "n")).toContain('<html lang="fa" dir="rtl">');
    const en = renderPaymentPage(view, "en", "n");
    expect(en).toContain('dir="ltr"');
    for (const l of LANGUAGES) expect(en).toContain(`href="?lang=${encodeURIComponent(l)}"`);
  });

  it("an invoice that can no longer be paid shows its status only: no amount, address, memo, QR or wallet link", () => {
    for (const status of ["expired", "cancelled", "completed", "rejected", "paid"]) {
      const html = renderPaymentPage({ ...view, status, payable: false }, "en", "n");
      expect(html, status).not.toContain(view.address);
      expect(html, status).not.toContain(">10.010000<");
      expect(html, status).not.toContain(">AB2C3D4E<");
      expect(html, status).not.toContain("<svg");
      expect(html, status).not.toContain('href="ton://');
      expect(html, status).toContain((MESSAGES.en.status as Record<string, string>)[status] ?? "MISSING");
    }
    // the status is rendered server side, so it is visible without JavaScript
    expect(renderPaymentPage(view, "en", "n")).toContain(">Waiting for your payment<");
  });

  it("tells the payer they may leave only once the payment is received", () => {
    const hint = (status: string) =>
      renderPaymentPage({ ...view, status, payable: false }, "en", "n").match(
        /<p[^>]*id="done-hint"[^>]*>/,
      )?.[0];
    for (const s of ["paid", "overpaid", "paid_late", "completed", "aml_pending"])
      expect(hint(s), s).not.toContain("hidden");
    for (const s of [
      "awaiting_payment",
      "confirming",
      "underpaid",
      "expired",
      "cancelled",
      "aml_hold",
      "rejected",
    ])
      expect(hint(s), s).toContain("hidden");
    expect(renderPaymentPage(view, "en", "n")).toContain(MESSAGES.en.doneHint.replace("'", "&#39;"));
    // the script reveals the hint for the same statuses when polling sees the payment
    expect(renderPaymentPage(view, "en", "n")).toMatch(
      /var OK = \{paid:1,overpaid:1,paid_late:1,completed:1,aml_pending:1\}/,
    );
  });

  it("return URLs: the success button once received (instead of the hint), the cancel link until then", () => {
    const urls = { successUrl: "https://shop.example/ok?a=1&b=2", cancelUrl: "https://shop.example/back" };
    const waiting = renderPaymentPage({ ...view, ...urls }, "ru", "n");
    expect(waiting).toMatch(/id="back-success" href="https:\/\/shop\.example\/ok\?a=1&amp;b=2"[^>]* hidden>/);
    expect(waiting).toMatch(
      /id="back-cancel" href="https:\/\/shop\.example\/back" rel="noopener noreferrer">/,
    );
    expect(waiting).toContain(`>${MESSAGES.ru.backToMerchant}<`);
    const paid = renderPaymentPage({ ...view, ...urls, status: "completed", payable: false }, "en", "n");
    expect(paid).toMatch(/id="back-success"[^>]*rel="noopener noreferrer">/);
    expect(paid).toMatch(/id="back-cancel"[^>]* hidden>/);
    expect(paid).toMatch(/id="done-hint" hidden>/);
    // without URLs: no links at all
    const plain = renderPaymentPage(view, "en", "n");
    expect(plain).not.toContain(`id="back-success"`);
    expect(plain).not.toContain(`id="back-cancel"`);
  });

  it("payable: payable statuses inside the grace period only", () => {
    const grace = new Date("2026-10-26T13:30:00Z");
    const before = new Date("2026-10-26T13:00:00Z");
    const after = new Date("2026-10-26T13:30:01Z");
    for (const s of ["awaiting_payment", "confirming", "underpaid", "expired"]) {
      expect(isPayable(s, grace, before), s).toBe(true);
      expect(isPayable(s, grace, after), s).toBe(false);
    }
    for (const s of [
      "paid",
      "overpaid",
      "paid_late",
      "cancelled",
      "aml_pending",
      "aml_hold",
      "completed",
      "rejected",
    ])
      expect(isPayable(s, grace, before), s).toBe(false);
  });

  it("the page script polls until the grace period ends and treats underpaid as still open", () => {
    const html = renderPaymentPage(view, "en", "n");
    expect(html).toContain('"graceUntil":"2026-10-26T13:30:00.000Z"');
    expect(html).toMatch(/Date\.parse\(d\.graceUntil\)/);
    expect(html).not.toMatch(/FINAL = \{[^}]*underpaid/);
  });

  it("TRON (no wallet URI): the QR carries the address and there is no wallet button", () => {
    const tron = { ...view, uri: null, memo: null, address: "TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq" };
    const html = renderPaymentPage(tron, "ru", "n");
    expect(html).not.toContain("Открыть в кошельке");
    expect(html).not.toContain("Комментарий (memo)");
  });
});
