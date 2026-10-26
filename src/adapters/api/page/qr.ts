// SPDX-License-Identifier: Apache-2.0
// QR code as inline SVG (no external resources). Encoding by qrcode-generator (MIT, no dependencies, ADR-0026);
// the SVG markup is ours so that it stays compatible with the page's Content-Security-Policy.
import qrcode from "qrcode-generator";

export interface QrMatrix {
  readonly size: number;
  isDark(row: number, col: number): boolean;
}

/** Byte-mode QR, error correction M, smallest version that fits. ASCII input only (addresses, URIs, memos). */
export function qrMatrix(text: string): QrMatrix {
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error("QR payload must be printable ASCII");
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  return { size: qr.getModuleCount(), isDark: (r, c) => qr.isDark(r, c) };
}

export function qrSvg(text: string, label: string): string {
  const m = qrMatrix(text);
  const quiet = 4;
  const n = m.size + quiet * 2;
  let d = "";
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) if (m.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
