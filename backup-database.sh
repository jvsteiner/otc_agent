#!/bin/bash
# Database Backup Script
# Creates timestamped backup of production database

DB_PATH="packages/backend/data/otc-production.db"
BACKUP_DIR="packages/backend/data/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH="${BACKUP_DIR}/otc-production.db.backup-${TIMESTAMP}"

echo "🔐 Database Backup Script"
echo "════════════════════════════════════════════════════════════════"
echo "Source:      ${DB_PATH}"
echo "Destination: ${BACKUP_PATH}"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Check if source database exists
if [ ! -f "${DB_PATH}" ]; then
  echo "❌ Error: Database file not found at ${DB_PATH}"
  exit 1
fi

# Create backup directory if it doesn't exist
mkdir -p "${BACKUP_DIR}"

# Get database size
DB_SIZE=$(du -h "${DB_PATH}" | cut -f1)
echo "📊 Database size: ${DB_SIZE}"
echo ""

# Create backup
echo "📦 Creating backup..."
cp "${DB_PATH}" "${BACKUP_PATH}"

# Also backup WAL and SHM files if they exist
if [ -f "${DB_PATH}-wal" ]; then
  cp "${DB_PATH}-wal" "${BACKUP_PATH}-wal"
  echo "   - Backed up WAL file"
fi

if [ -f "${DB_PATH}-shm" ]; then
  cp "${DB_PATH}-shm" "${BACKUP_PATH}-shm"
  echo "   - Backed up SHM file"
fi

# Verify backup
if [ -f "${BACKUP_PATH}" ]; then
  BACKUP_SIZE=$(du -h "${BACKUP_PATH}" | cut -f1)
  echo ""
  echo "✅ Backup created successfully!"
  echo "   Size: ${BACKUP_SIZE}"
  echo "   Location: ${BACKUP_PATH}"
  echo ""

  # Calculate checksum
  ORIGINAL_CHECKSUM=$(sha256sum "${DB_PATH}" | cut -d' ' -f1)
  BACKUP_CHECKSUM=$(sha256sum "${BACKUP_PATH}" | cut -d' ' -f1)

  if [ "${ORIGINAL_CHECKSUM}" = "${BACKUP_CHECKSUM}" ]; then
    echo "✅ Checksum verified - backup is identical to original"
  else
    echo "⚠️  Warning: Checksum mismatch - backup may be corrupted"
    exit 1
  fi

  # Show recent backups
  echo ""
  echo "📋 Recent backups:"
  ls -lht "${BACKUP_DIR}" | head -6

else
  echo "❌ Error: Backup failed"
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "Backup complete!"
echo ""
echo "To restore this backup:"
echo "  cp ${BACKUP_PATH} ${DB_PATH}"
echo ""
