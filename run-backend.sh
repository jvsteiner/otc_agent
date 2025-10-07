#!/bin/bash

# OTC Backend Runner with Logging
# This script runs the backend and logs output to both console and file

# Create logs directory if it doesn't exist
mkdir -p logs

# Generate log filename with timestamp
LOG_FILE="logs/otc-backend-$(date +%Y%m%d-%H%M%S).log"

echo "Starting OTC Backend..."
echo "Logging to: $LOG_FILE"
echo "Press Ctrl+C to stop"
echo "----------------------------------------"

# Run the backend with tee to output to both console and log file
cd /home/vrogojin/otc_agent
npm run dev 2>&1 | tee "$LOG_FILE"

echo "----------------------------------------"
echo "Backend stopped. Log saved to: $LOG_FILE"