#!/bin/bash

# OTC Backend Runner with Full Rebuild and Clean Restart
# This script ensures fresh updates are always applied by:
# 1. Killing any existing backend processes
# 2. Cleaning node module cache
# 3. Rebuilding all packages
# 4. Starting backend with clean process

set -e  # Exit on error

# Create logs directory if it doesn't exist
mkdir -p logs

# Generate log filename with timestamp
LOG_FILE="logs/otc-backend-$(date +%Y%m%d-%H%M%S).log"

echo "========================================" | tee "$LOG_FILE"
echo "OTC Backend - Full Rebuild and Restart" | tee -a "$LOG_FILE"
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

# Step 4: Start backend with clean process
echo "[4/4] Starting backend..." | tee -a "$LOG_FILE"
echo "Press Ctrl+C to stop" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Run the backend with tee to output to both console and log file
npm run dev 2>&1 | tee -a "$LOG_FILE"

echo "----------------------------------------"
echo "Backend stopped. Log saved to: $LOG_FILE"