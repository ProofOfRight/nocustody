-- SPDX-License-Identifier: Apache-2.0
-- Candidates are per asset: one transaction may carry transfers of several configured assets, and a hint about one
-- asset must never hide the real transfer of another. A verified transfer still points at its candidate, now by
-- asset as well (the verifier reads a candidate's asset only). Also the indexes behind the queries that run every
-- minute: the verifier's oldest-first batch, the monitor's dead-letter count and the merchant's invoice list.
-- The tables are small at this point of the project (0.2.x); the index builds take a short lock.
ALTER TABLE observed_transfers DROP CONSTRAINT observed_transfers_network_tx_hash_fkey;
ALTER TABLE tx_candidates DROP CONSTRAINT tx_candidates_pkey;
ALTER TABLE tx_candidates ADD PRIMARY KEY (network, tx_hash, asset_id);
ALTER TABLE observed_transfers
  ADD FOREIGN KEY (network, tx_hash, asset_id) REFERENCES tx_candidates (network, tx_hash, asset_id);
DROP INDEX tx_candidates_seen;
CREATE INDEX tx_candidates_seen ON tx_candidates (network, block_time, tx_hash) WHERE status = 'seen';
CREATE INDEX outbox_dead ON outbox (id) WHERE dead_at IS NOT NULL;
CREATE INDEX invoices_created ON invoices (created_at DESC, id);
