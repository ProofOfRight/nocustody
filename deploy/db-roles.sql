-- SPDX-License-Identifier: Apache-2.0
-- Runtime role of the gateway (docs/deployment.md#database-roles): data access only, no DDL, no superuser, and the
-- payment history is append-only. Migrations keep running as the owner role. Idempotent: the db-roles service in
-- compose.yaml runs it after every migration, so tables added by a new version get the same grants.
-- psql -v app_password=... -f db-roles.sql
SELECT 'CREATE ROLE nocustody_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocustody_app') \gexec
ALTER ROLE nocustody_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'app_password';

REVOKE ALL ON DATABASE nocustody FROM PUBLIC;
GRANT CONNECT ON DATABASE nocustody TO nocustody_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nocustody_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nocustody_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nocustody_app;
-- What happened stays as it happened. observed_transfers keeps UPDATE: settlement moves a transfer's status.
REVOKE UPDATE, DELETE ON audit_log, invoice_payments FROM nocustody_app;
REVOKE DELETE ON observed_transfers FROM nocustody_app;
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM nocustody_app;
