-- SPDX-License-Identifier: Apache-2.0
-- Return URLs of the hosted payment page (ADR-0035): where the "Back to the merchant's website" button points after
-- the payment is received (success) or when the invoice can no longer be paid (cancel). Optional, set on creation.
ALTER TABLE invoices ADD COLUMN success_url text, ADD COLUMN cancel_url text;
