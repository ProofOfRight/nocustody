-- SPDX-License-Identifier: Apache-2.0
-- Operations: process heartbeats and shared guards (e.g. depeg blocks new invoices).

CREATE TABLE heartbeats (
  role          text PRIMARY KEY,
  last_ok_at    timestamptz,
  last_error_at timestamptz,
  last_error    text
);

CREATE TABLE guards (
  key        text PRIMARY KEY,
  blocked    boolean NOT NULL,
  reason     text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX tx_candidates_recipient_time ON tx_candidates (network, recipient, block_time);
