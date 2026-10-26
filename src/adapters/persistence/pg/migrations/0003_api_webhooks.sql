-- SPDX-License-Identifier: Apache-2.0
-- Merchant API keys (stored as SHA-256 of a 256-bit random secret), idempotency keys, webhook delivery state.

CREATE TABLE api_keys (
  id            text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{12}$'),
  name          text NOT NULL,
  secret_sha256 text NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  scopes        text[] NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz
);

CREATE TABLE idempotency_keys (
  api_key_id     text NOT NULL REFERENCES api_keys (id),
  key            text NOT NULL,
  request_sha256 text NOT NULL,
  invoice_id     text NOT NULL REFERENCES invoices (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, key)
);

ALTER TABLE outbox ADD COLUMN dead_at timestamptz;
ALTER TABLE outbox ADD COLUMN last_error text;
DROP INDEX outbox_pending;
CREATE INDEX outbox_pending ON outbox (next_attempt_at) WHERE delivered_at IS NULL AND dead_at IS NULL;
