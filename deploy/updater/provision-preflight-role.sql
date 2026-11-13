-- Run as the database administrator once, outside the automatic updater.
-- Set password using the administrator's secure psql variable, not SQL source or logs.
\set ON_ERROR_STOP on
SELECT format('CREATE ROLE codexia_preflight LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'preflight_password') \gexec
ALTER ROLE codexia_preflight SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE codexia TO codexia_preflight;
GRANT USAGE ON SCHEMA public TO codexia_preflight;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO codexia_preflight;
-- Explicitly avoid ownership, role membership, sequence usage, DDL or DML grants.
-- Future major migrations must update this role through the operator, not the updater.
