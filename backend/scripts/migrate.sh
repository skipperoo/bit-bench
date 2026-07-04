#!/bin/bash
set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-bitbench}"
DB_NAME="${DB_NAME:-bitbench}"
DB_PASSWORD="$(cat /run/secrets/db_password 2>/dev/null || echo "${DB_PASSWORD:-bitbench}")"

MIGRATIONS_DIR="$(dirname "$0")/../internal/config/migrations"

PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
CREATE TABLE IF NOT EXISTS _migrations (
    filename    VARCHAR(255) PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"

for f in "$MIGRATIONS_DIR"/*.sql; do
    filename="$(basename "$f")"
    already_applied=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT 1 FROM _migrations WHERE filename='$filename'")
    if [ -z "$already_applied" ]; then
        echo "Applying $filename..."
        PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$f"
        PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "INSERT INTO _migrations (filename) VALUES ('$filename')"
        echo "Applied $filename"
    else
        echo "Skipping $filename (already applied)"
    fi
done
