-- Install Postgres extensions on first container start.
-- This script runs only when the data volume is empty (first run).
-- IF NOT EXISTS keeps it idempotent if you re-run manually.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;