-- SPDX-License-Identifier: Apache-2.0
-- Initial schema. Amounts are numeric(78,0) minimal units (fits uint256); never floating point.

-- Needed for the exclusion constraint on amount slots (equality on scalar columns inside a GiST index).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE invoices (
  id                text PRIMARY KEY,
  merchant_order_id text NOT NULL UNIQUE,
  network           text NOT NULL,
  asset_id          text NOT NULL,
  expected_units    numeric(78, 0) NOT NULL CHECK (expected_units > 0),
  pay_address       text NOT NULL,
  pay_amount_units  numeric(78, 0) NOT NULL CHECK (pay_amount_units > 0),
  memo              text,
  price             jsonb,
  created_at        timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  grace_until       timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN (
                      'awaiting_payment', 'confirming', 'paid', 'underpaid', 'overpaid', 'paid_late', 'expired',
                      'cancelled', 'aml_pending', 'aml_hold', 'completed', 'rejected')),
  aml_reason        text,
  version           integer NOT NULL CHECK (version >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND grace_until >= expires_at)
);
CREATE INDEX invoices_status_expires ON invoices (status, expires_at);

CREATE TABLE invoice_payments (
  invoice_id   text NOT NULL REFERENCES invoices (id),
  transfer_key text NOT NULL UNIQUE, -- one transfer pays at most one invoice
  sender       text NOT NULL,
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  paid_at      timestamptz NOT NULL,
  PRIMARY KEY (invoice_id, transfer_key)
);

-- (address, amount) reserved for one invoice during [valid_from, lock_until]; lock_until = expires_at + grace + skew.
-- The exclusion constraint guarantees at the database level that windows for the same pair never overlap.
CREATE TABLE amount_slots (
  invoice_id   text NOT NULL REFERENCES invoices (id) DEFERRABLE INITIALLY DEFERRED,
  network      text NOT NULL,
  address      text NOT NULL,
  asset_id     text NOT NULL,
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  valid_from   timestamptz NOT NULL,
  valid_until  timestamptz NOT NULL,
  lock_until   timestamptz NOT NULL,
  CHECK (valid_until > valid_from AND lock_until >= valid_until),
  EXCLUDE USING gist (
    network WITH =, address WITH =, asset_id WITH =, amount_units WITH =,
    tstzrange(valid_from, lock_until, '[]') WITH &&
  )
);
CREATE INDEX amount_slots_lookup ON amount_slots (network, address, amount_units);

-- Transactions reported by an indexer (untrusted hint). Verified transfers are created from them by the verifier.
CREATE TABLE tx_candidates (
  network      text NOT NULL,
  tx_hash      text NOT NULL,
  asset_id     text NOT NULL,
  sender       text NOT NULL,
  recipient    text NOT NULL,
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units >= 0),
  block_time   timestamptz NOT NULL,
  status       text NOT NULL CHECK (status IN ('seen', 'dust', 'verified', 'rejected')),
  attempts     integer NOT NULL DEFAULT 0,
  reason       text,
  seen_at      timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, tx_hash)
);
CREATE INDEX tx_candidates_seen ON tx_candidates (network, seen_at) WHERE status = 'seen';

-- Transfers confirmed by a finalized-state query. Idempotency key: (network, tx_hash, log_index).
CREATE TABLE observed_transfers (
  network      text NOT NULL,
  tx_hash      text NOT NULL,
  log_index    numeric(20, 0) NOT NULL CHECK (log_index >= 0),
  asset_id     text NOT NULL,
  sender       text NOT NULL,
  recipient    text NOT NULL,
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units >= 0),
  block_time   timestamptz NOT NULL,
  status       text NOT NULL CHECK (status IN ('verified', 'dust', 'matched', 'unmatched')),
  invoice_id   text REFERENCES invoices (id),
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, tx_hash, log_index),
  FOREIGN KEY (network, tx_hash) REFERENCES tx_candidates (network, tx_hash)
);
CREATE INDEX observed_transfers_verified ON observed_transfers (network, created_at) WHERE status = 'verified';

-- Transactional outbox: events are inserted in the same transaction as the state change.
CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  event_id        uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  type            text NOT NULL,
  aggregate_id    text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox (next_attempt_at) WHERE delivered_at IS NULL;

CREATE TABLE scan_cursors (
  network    text NOT NULL,
  stream     text NOT NULL,
  cursor     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, stream)
);

-- Why each payment was credited or rejected.
CREATE TABLE audit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL,
  actor    text NOT NULL,
  subject  text NOT NULL,
  decision text NOT NULL,
  reason   text NOT NULL,
  data     jsonb
);
CREATE INDEX audit_log_subject ON audit_log (subject, at);
