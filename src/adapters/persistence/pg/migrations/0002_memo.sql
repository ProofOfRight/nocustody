-- SPDX-License-Identifier: Apache-2.0
-- Memo (text comment) payments: memo per invoice, unique per network forever (never reused).

ALTER TABLE tx_candidates ADD COLUMN memo text;
ALTER TABLE observed_transfers ADD COLUMN memo text;

CREATE TABLE memo_reservations (
  network    text NOT NULL,
  memo       text NOT NULL CHECK (memo ~ '^[0-9A-Z]{4,32}$'),
  invoice_id text NOT NULL REFERENCES invoices (id) DEFERRABLE INITIALLY DEFERRED,
  address    text NOT NULL,
  asset_id   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, memo)
);
