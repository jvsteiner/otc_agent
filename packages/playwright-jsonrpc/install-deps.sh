#!/bin/bash

# Playwright JSON-RPC Microservice - Dependency Installation Script
# This script installs the required system dependencies for Playwright to run

echo "============================================================"
echo "Playwright JSON-RPC - System Dependencies Installation"
echo "============================================================"
echo ""
echo "This script will install the required system packages for"
echo "Playwright to run browser automation."
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run this script with sudo:"
    echo "  sudo bash install-deps.sh"
    exit 1
fi

echo "Installing required packages..."
echo ""

# Update package list
apt-get update

# Install required dependencies
apt-get install -y \
    libnspr4 \
    libnss3 \
    libgbm1 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxkbcommon0 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libx11-xcb1

echo ""
echo "============================================================"
echo "Installation complete!"
echo "============================================================"
echo ""
echo "You can now start the Playwright JSON-RPC service:"
echo "  cd /home/vrogojin/otc_agent/packages/playwright-jsonrpc"
echo "  npm start"
echo ""
