#!/bin/bash

###############################################################################
# HTTPS Redirect Test Script
#
# This script tests the HTTP-to-HTTPS redirect functionality by simulating
# various HTTP requests and verifying the redirect behavior.
###############################################################################

DOMAIN="unicity-swap.dyndns.org"
HTTP_URL="http://${DOMAIN}"
HTTPS_URL="https://${DOMAIN}"

echo "═══════════════════════════════════════════════════════"
echo "🧪 HTTPS Redirect Test Suite"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Domain: ${DOMAIN}"
echo "HTTP:   ${HTTP_URL}"
echo "HTTPS:  ${HTTPS_URL}"
echo ""

# Function to test HTTP redirect
test_redirect() {
    local path="$1"
    local description="$2"

    echo "───────────────────────────────────────────────────────"
    echo "Test: ${description}"
    echo "Path: ${path}"
    echo ""

    # Make HTTP request and capture redirect
    echo "Request:  ${HTTP_URL}${path}"

    # Use curl to follow redirects and show the redirect chain
    echo ""
    echo "Response:"
    curl -sI -L "${HTTP_URL}${path}" | grep -E "(HTTP|Location|Strict-Transport-Security)" | head -10

    echo ""
}

# Test 1: Root path
test_redirect "/" "Root path redirect"

# Test 2: Deal page
test_redirect "/d/test-deal-id/a/test-token" "Deal page redirect"

# Test 3: RPC endpoint
test_redirect "/rpc" "RPC endpoint redirect"

# Test 4: Static assets
test_redirect "/assets/style.css" "Static asset redirect"

# Test 5: With query parameters
test_redirect "/d/deal123/a/token456?foo=bar&baz=qux" "Path with query parameters"

echo "═══════════════════════════════════════════════════════"
echo "📋 Expected Behavior"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Each HTTP request should show:"
echo "  1. HTTP/1.1 301 Moved Permanently"
echo "  2. Location: ${HTTPS_URL}/path (with path preserved)"
echo "  3. Strict-Transport-Security header (HSTS)"
echo ""
echo "Then follow to:"
echo "  4. HTTP/2 200 OK (or appropriate status from HTTPS)"
echo ""
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Note: This test requires the production server to be running"
echo "      with SSL enabled and HTTP redirect active."
echo ""
echo "To start the server:"
echo "  npm run prod"
echo ""
echo "To test manually:"
echo "  curl -I ${HTTP_URL}/test/path"
echo ""
