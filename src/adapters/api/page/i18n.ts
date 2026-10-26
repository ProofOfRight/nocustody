// SPDX-License-Identifier: Apache-2.0
// Payment page texts. Translations other than English were written without a native speaker and must be reviewed
// (docs/payment-page.md). Persian is right-to-left; its zero-width non-joiners are written as \u200c escapes so
// that no invisible characters appear in the source (source policy).

export const LANGUAGES = ["en", "ru", "fr", "fa", "zh-CN"] as const;
export type Lang = (typeof LANGUAGES)[number];

export interface Messages {
  readonly title: string;
  readonly send: string;
  readonly exactly: string;
  readonly network: string;
  readonly toAddress: string;
  readonly memo: string;
  readonly memoWarning: string;
  readonly copy: string;
  readonly copied: string;
  readonly openWallet: string;
  readonly timeLeft: string;
  readonly qr: string;
  readonly onlyAsset: string;
  readonly status: Readonly<Record<string, string>>;
}

const en: Messages = {
  title: "Payment",
  send: "Send",
  exactly: "Send exactly this amount — a different amount may not be recognised.",
  network: "Network",
  toAddress: "To address",
  memo: "Comment (memo)",
  memoWarning: "Add this comment to the transfer, otherwise the payment may not be recognised.",
  copy: "Copy",
  copied: "Copied",
  openWallet: "Open in wallet",
  timeLeft: "Time left",
  qr: "QR code with the payment details",
  onlyAsset: "Send only {asset} on {network}. Other tokens or networks are lost.",
  status: {
    awaiting_payment: "Waiting for your payment",
    confirming: "Payment detected, waiting for confirmation",
    paid: "Payment received",
    overpaid: "Payment received",
    paid_late: "Payment received",
    aml_pending: "Payment received, checking",
    completed: "Payment received",
    underpaid: "Received less than required — please contact the merchant",
    expired:
      "This invoice has expired — do not send a payment. A payment you already sent will still be detected.",
    cancelled: "This invoice was cancelled — do not pay",
    aml_hold: "Payment received, under review",
    rejected: "Payment under review — please contact the merchant",
  },
};

const ru: Messages = {
  title: "Оплата",
  send: "Отправьте",
  exactly: "Отправьте ровно эту сумму — другая сумма может быть не распознана.",
  network: "Сеть",
  toAddress: "На адрес",
  memo: "Комментарий (memo)",
  memoWarning: "Добавьте этот комментарий к переводу, иначе платёж может быть не распознан.",
  copy: "Копировать",
  copied: "Скопировано",
  openWallet: "Открыть в кошельке",
  timeLeft: "Осталось",
  qr: "QR-код с реквизитами платежа",
  onlyAsset: "Отправляйте только {asset} в сети {network}. Другие токены или сети будут потеряны.",
  status: {
    awaiting_payment: "Ожидаем ваш платёж",
    confirming: "Платёж обнаружен, ждём подтверждения",
    paid: "Платёж получен",
    overpaid: "Платёж получен",
    paid_late: "Платёж получен",
    aml_pending: "Платёж получен, идёт проверка",
    completed: "Платёж получен",
    underpaid: "Получено меньше нужного — свяжитесь с продавцом",
    expired: "Срок счёта истёк — не отправляйте платёж. Уже отправленный платёж всё равно будет обнаружен.",
    cancelled: "Счёт отменён — не оплачивайте",
    aml_hold: "Платёж получен, на проверке",
    rejected: "Платёж на проверке — свяжитесь с продавцом",
  },
};

const fr: Messages = {
  title: "Paiement",
  send: "Envoyez",
  exactly: "Envoyez exactement ce montant — un autre montant risque de ne pas être reconnu.",
  network: "Réseau",
  toAddress: "À l’adresse",
  memo: "Commentaire (memo)",
  memoWarning: "Ajoutez ce commentaire au transfert, sinon le paiement risque de ne pas être reconnu.",
  copy: "Copier",
  copied: "Copié",
  openWallet: "Ouvrir dans le portefeuille",
  timeLeft: "Temps restant",
  qr: "Code QR avec les détails du paiement",
  onlyAsset: "Envoyez uniquement {asset} sur {network}. Les autres jetons ou réseaux seront perdus.",
  status: {
    awaiting_payment: "En attente de votre paiement",
    confirming: "Paiement détecté, en attente de confirmation",
    paid: "Paiement reçu",
    overpaid: "Paiement reçu",
    paid_late: "Paiement reçu",
    aml_pending: "Paiement reçu, vérification en cours",
    completed: "Paiement reçu",
    underpaid: "Montant reçu insuffisant — contactez le marchand",
    expired:
      "Cette facture a expiré — n’envoyez pas de paiement. Un paiement déjà envoyé sera tout de même détecté.",
    cancelled: "Cette facture a été annulée — ne payez pas",
    aml_hold: "Paiement reçu, en cours d’examen",
    rejected: "Paiement en cours d’examen — contactez le marchand",
  },
};

const fa: Messages = {
  title: "پرداخت",
  send: "ارسال کنید",
  exactly: "دقیقاً همین مبلغ را ارسال کنید — مبلغ متفاوت ممکن است شناسایی نشود.",
  network: "شبکه",
  toAddress: "به آدرس",
  memo: "توضیح (memo)",
  memoWarning: "این توضیح را به انتقال اضافه کنید، در غیر این صورت پرداخت ممکن است شناسایی نشود.",
  copy: "کپی",
  copied: "کپی شد",
  openWallet: "باز کردن در کیف پول",
  timeLeft: "زمان باقی\u200cمانده",
  qr: "کد QR با جزئیات پرداخت",
  onlyAsset:
    "فقط {asset} را در شبکه {network} ارسال کنید. توکن\u200cها یا شبکه\u200cهای دیگر از دست می\u200cروند.",
  status: {
    awaiting_payment: "در انتظار پرداخت شما",
    confirming: "پرداخت شناسایی شد، در انتظار تأیید",
    paid: "پرداخت دریافت شد",
    overpaid: "پرداخت دریافت شد",
    paid_late: "پرداخت دریافت شد",
    aml_pending: "پرداخت دریافت شد، در حال بررسی",
    completed: "پرداخت دریافت شد",
    underpaid: "مبلغ دریافتی کمتر از مقدار لازم است — با فروشنده تماس بگیرید",
    expired:
      "مهلت این صورت\u200cحساب تمام شده است — پرداخت ارسال نکنید. پرداختی که قبلاً ارسال شده باشد همچنان شناسایی می\u200cشود.",
    cancelled: "این صورت\u200cحساب لغو شده است — پرداخت نکنید",
    aml_hold: "پرداخت دریافت شد، در حال بررسی",
    rejected: "پرداخت در حال بررسی است — با فروشنده تماس بگیرید",
  },
};

const zhCN: Messages = {
  title: "付款",
  send: "请发送",
  exactly: "请准确发送此金额——金额不同可能无法识别。",
  network: "网络",
  toAddress: "收款地址",
  memo: "备注（memo）",
  memoWarning: "请在转账中填写此备注，否则付款可能无法识别。",
  copy: "复制",
  copied: "已复制",
  openWallet: "在钱包中打开",
  timeLeft: "剩余时间",
  qr: "包含付款信息的二维码",
  onlyAsset: "仅发送 {network} 网络上的 {asset}。发送其他代币或使用其他网络将会丢失。",
  status: {
    awaiting_payment: "等待您的付款",
    confirming: "已检测到付款，等待确认",
    paid: "已收到付款",
    overpaid: "已收到付款",
    paid_late: "已收到付款",
    aml_pending: "已收到付款，正在核查",
    completed: "已收到付款",
    underpaid: "收到的金额不足——请联系商家",
    expired: "此账单已过期——请勿付款。已发送的付款仍会被识别。",
    cancelled: "此账单已取消——请勿付款",
    aml_hold: "已收到付款，正在审核",
    rejected: "付款正在审核——请联系商家",
  },
};

export const MESSAGES: Readonly<Record<Lang, Messages>> = { en, ru, fr, fa, "zh-CN": zhCN };

export const isRtl = (lang: Lang): boolean => lang === "fa";

/** ?lang= wins, then the first supported Accept-Language entry (by q), then the default. */
export function pickLanguage(
  query: string | undefined,
  acceptLanguage: string | undefined,
  fallback: Lang,
): Lang {
  const match = (tag: string): Lang | null => {
    const t = tag.trim().toLowerCase();
    if (t === "zh" || t.startsWith("zh-cn") || t.startsWith("zh-hans") || t === "zh-sg") return "zh-CN";
    const base = t.split("-")[0];
    return (LANGUAGES as readonly string[]).includes(base ?? "") && base !== "zh" ? (base as Lang) : null;
  };
  if (query) {
    const q = match(query);
    if (q) return q;
  }
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.split(";");
      const qv = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag, q: qv ? Number(qv.slice(2)) : 1 };
    })
    .filter((x) => x.tag && Number.isFinite(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const l = match(tag);
    if (l) return l;
  }
  return fallback;
}
