#!/usr/bin/env bash
# Restore a database backup created by backup-db.sh
# Usage: ./scripts/restore-db.sh /opt/attendance/backups/attendance_20260901_020000.sql.gz

set -euo pipefail

FILE="${1:?Usage: restore-db.sh <backup-file.sql.gz>}"
CONTAINER_NAME="${POSTGRES_CONTAINER:-attendance-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-attendance}"
POSTGRES_DB="${POSTGRES_DB:-attendance}"

echo "WARNING: this will overwrite the current database ($POSTGRES_DB)."
read -p "Type YES to continue: " confirm
if [ "$confirm" != "YES" ]; then
  echo "Aborted."
  exit 1
fi

gunzip -c "$FILE" | docker exec -i "$CONTAINER_NAME" psql -U "$POSTGRES_USER" "$POSTGRES_DB"

echo "Restore complete."
