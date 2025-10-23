#!/bin/bash

# OTC Backend Production Runner with Full Rebuild and Clean Restart
# This script ensures fresh updates are always applied by:
# 1. Killing any existing backend processes
# 2. Cleaning node module cache
# 3. Rebuilding all packages
# 4. Starting backend in production mode with compiled code
# 5. Using .env.production for production configuration (PORT=80)
#
# NOTE: Port 80 requires elevated privileges. Run with:
#   sudo ./run-prod.sh
# OR in Docker where the container has appropriate capabilities.

set -e  # Exit on error

# Check if running on port 80 and warn about permissions
if [ "$EUID" -ne 0 ] && grep -q "^PORT=80" .env.production 2>/dev/null; then
  echo "⚠️  WARNING: Production mode uses PORT=80 which requires root privileges."
  echo "   Current user: $(whoami) (not root)"
  echo ""
  echo "   Options:"
  echo "   1. Run with sudo: sudo ./run-prod.sh"
  echo "   2. Use Docker (recommended for production)"
  echo "   3. Change PORT in .env.production to 8080"
  echo ""
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Function to restore development .env on exit
restore_env() {
  echo ""
  echo "Restoring development configuration..."
  if [ -f .env.backup.dev ]; then
    mv .env.backup.dev .env
    echo "  ✓ Restored .env from backup"
  fi
}

# Register cleanup function to run on exit (including Ctrl+C)
trap restore_env EXIT

# Create logs directory if it doesn't exist
mkdir -p logs

# Create data directory if it doesn't exist (for database)
mkdir -p data

# Backup current .env and use .env.production
echo "Switching to production environment configuration..."
if [ -f .env ]; then
  cp .env .env.backup.dev
  echo "  ✓ Backed up .env to .env.backup.dev"
fi
if [ -f .env.production ]; then
  cp .env.production .env
  echo "  ✓ Activated .env.production (PORT=80)"
else
  echo "  ERROR: .env.production not found!"
  exit 1
fi

# Generate log filename with timestamp
LOG_FILE="logs/otc-prod-$(date +%Y%m%d-%H%M%S).log"

echo "========================================" | tee "$LOG_FILE"
echo "OTC Backend - Production Mode" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Log file: $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Step 1: Kill existing backend processes
echo "[1/4] Stopping existing backend processes..." | tee -a "$LOG_FILE"
pkill -f "tsx watch src/index.ts" 2>/dev/null || echo "  No tsx processes to kill" | tee -a "$LOG_FILE"
pkill -f "node.*dist/index.js" 2>/dev/null || echo "  No node backend processes to kill" | tee -a "$LOG_FILE"
sleep 2
echo "  Done" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Step 2: Clear Node.js module cache for workspace packages
echo "[2/4] Clearing Node.js module cache..." | tee -a "$LOG_FILE"
cd /home/vrogojin/otc_agent
rm -rf packages/*/dist/.cache 2>/dev/null || true
rm -rf node_modules/.cache 2>/dev/null || true
echo "  Done" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Step 3: Full rebuild of all packages
echo "[3/4] Rebuilding all packages..." | tee -a "$LOG_FILE"
npm run build 2>&1 | tee -a "$LOG_FILE"
echo "  Done" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Step 4: Start backend in production mode
echo "[4/4] Starting backend in production mode..." | tee -a "$LOG_FILE"
echo "Press Ctrl+C to stop" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Run the backend with tee to output to both console and log file
npm run prod 2>&1 | tee -a "$LOG_FILE"

# Note: .env restoration happens automatically via trap on EXIT
echo ""
echo "----------------------------------------"
echo "Backend stopped. Log saved to: $LOG_FILE"
