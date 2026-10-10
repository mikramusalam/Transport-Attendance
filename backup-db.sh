#!/usr/bin/env bash
# Daily PostgreSQL backup with 14-day local rotation.
# Schedule with cron, e.g.:
#   0 2 * * *  /opt/attendance/scripts/backup-db.sh >> /var/log/attendance-backup.log 2>&1
#
# For off-server backups (recommended), sync BACKUP_DIR to Backblaze B2 or
# similar cheap object storage using `rclone` (see README "Backups" section).

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/attendance/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
CONTAINER_NAME="${POSTGRES_CONTAINER:-attendance-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-attendance}"
POSTGRES_DB="${POSTGRES_DB:-attendance}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUT_FILE="$BACKUP_DIR/attendance_${TIMESTAMP}.sql.gz"

docker exec "$CONTAINER_NAME" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$OUT_FILE"

echo "Backup written to $OUT_FILE"

# Remove backups older than RETENTION_DAYS
find "$BACKUP_DIR" -name 'attendance_*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "Backup complete. Retention: ${RETENTION_DAYS} days."
