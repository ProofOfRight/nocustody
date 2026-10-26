// SPDX-License-Identifier: Apache-2.0
import jsqrImport from "jsqr";
import { describe, expect, it } from "vitest";
import { LANGUAGES, MESSAGES, pickLanguage } from "./i18n.ts";
import { qrMatrix } from "./qr.ts";
import { contentSecurityPolicy, type PageView, renderPaymentPage } from "./render.ts";

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
  statusUrl: "/pay/0b9e6a4e-6f2a-4c1e-9d55-1f0c6b8f1a11/status",
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

  it("TRON (no wallet URI): the QR carries the address and there is no wallet button", () => {
    const tron = { ...view, uri: null, memo: null, address: "TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq" };
    const html = renderPaymentPage(tron, "ru", "n");
    expect(html).not.toContain("Открыть в кошельке");
    expect(html).not.toContain("Комментарий (memo)");
  });
});
