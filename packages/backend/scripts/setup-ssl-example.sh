#!/bin/bash

###############################################################################
# SSL Certificate Setup Example Script
# This script demonstrates how to set up SSL certificates for the OTC Broker
###############################################################################

set -e  # Exit on error

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SSL_DIR="$PROJECT_ROOT/.ssl"

echo "=============================================="
echo "SSL Certificate Setup for OTC Broker"
echo "=============================================="
echo ""
echo "Project root: $PROJECT_ROOT"
echo "SSL directory: $SSL_DIR"
echo ""

# Function to print section headers
print_section() {
    echo ""
    echo "----------------------------------------------"
    echo "$1"
    echo "----------------------------------------------"
}

# Check if .ssl directory exists
if [ -d "$SSL_DIR" ]; then
    echo "⚠️  SSL directory already exists: $SSL_DIR"
    echo "Files in directory:"
    ls -lh "$SSL_DIR"
    echo ""
    read -p "Do you want to continue and potentially overwrite files? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

# Create SSL directory
mkdir -p "$SSL_DIR"
echo "✓ Created SSL directory: $SSL_DIR"

# Menu for certificate type
print_section "Choose Certificate Type"
echo "1) Self-signed certificate (for development/testing)"
echo "2) Let's Encrypt certificate (recommended for production)"
echo "3) Copy existing certificate files"
echo "4) Exit"
echo ""
read -p "Enter your choice (1-4): " choice

case $choice in
    1)
        print_section "Generating Self-Signed Certificate"
        echo "This will create a self-signed certificate valid for 365 days."
        echo "⚠️  Self-signed certificates will show security warnings in browsers."
        echo ""

        # Prompt for hostname
        read -p "Enter hostname/domain (default: localhost): " hostname
        hostname=${hostname:-localhost}

        # Generate self-signed certificate
        openssl req -x509 -newkey rsa:4096 -nodes \
            -keyout "$SSL_DIR/key.pem" \
            -out "$SSL_DIR/cert.pem" \
            -days 365 \
            -subj "/CN=$hostname" \
            -addext "subjectAltName=DNS:$hostname,DNS:www.$hostname,DNS:localhost,IP:127.0.0.1"

        echo ""
        echo "✓ Self-signed certificate generated successfully!"
        echo "  Certificate: $SSL_DIR/cert.pem"
        echo "  Private Key: $SSL_DIR/key.pem"
        ;;

    2)
        print_section "Let's Encrypt Certificate Setup"
        echo "This option will guide you through obtaining a Let's Encrypt certificate."
        echo ""
        echo "Prerequisites:"
        echo "  - certbot installed (sudo apt-get install certbot)"
        echo "  - Domain pointing to this server"
        echo "  - Port 80 available (for HTTP-01 challenge)"
        echo ""

        read -p "Enter your domain name: " domain

        if [ -z "$domain" ]; then
            echo "❌ Domain name is required"
            exit 1
        fi

        echo ""
        echo "To obtain a Let's Encrypt certificate, run:"
        echo ""
        echo "  sudo certbot certonly --standalone -d $domain"
        echo ""
        echo "Then copy the certificates to the SSL directory:"
        echo ""
        echo "  sudo cp /etc/letsencrypt/live/$domain/fullchain.pem $SSL_DIR/cert.pem"
        echo "  sudo cp /etc/letsencrypt/live/$domain/privkey.pem $SSL_DIR/key.pem"
        echo "  sudo cp /etc/letsencrypt/live/$domain/chain.pem $SSL_DIR/ca.pem"
        echo "  sudo chown $USER:$USER $SSL_DIR/*.pem"
        echo "  chmod 600 $SSL_DIR/*.pem"
        echo ""

        read -p "Do you want to run these commands now? (requires sudo) (y/N) " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Running certbot..."
            sudo certbot certonly --standalone -d "$domain"

            echo "Copying certificates..."
            sudo cp "/etc/letsencrypt/live/$domain/fullchain.pem" "$SSL_DIR/cert.pem"
            sudo cp "/etc/letsencrypt/live/$domain/privkey.pem" "$SSL_DIR/key.pem"
            sudo cp "/etc/letsencrypt/live/$domain/chain.pem" "$SSL_DIR/ca.pem"
            sudo chown "$USER:$USER" "$SSL_DIR"/*.pem
            chmod 600 "$SSL_DIR"/*.pem

            echo ""
            echo "✓ Let's Encrypt certificate installed successfully!"
        else
            echo "Please run the commands manually when ready."
            exit 0
        fi
        ;;

    3)
        print_section "Copy Existing Certificate Files"
        echo "Please provide the paths to your certificate files."
        echo ""

        read -p "Path to certificate file (cert.pem, fullchain.pem, etc.): " cert_path
        read -p "Path to private key file (key.pem, privkey.pem, etc.): " key_path
        read -p "Path to CA bundle (optional, press Enter to skip): " ca_path

        if [ ! -f "$cert_path" ]; then
            echo "❌ Certificate file not found: $cert_path"
            exit 1
        fi

        if [ ! -f "$key_path" ]; then
            echo "❌ Private key file not found: $key_path"
            exit 1
        fi

        # Copy certificate files
        cp "$cert_path" "$SSL_DIR/cert.pem"
        cp "$key_path" "$SSL_DIR/key.pem"

        if [ -n "$ca_path" ] && [ -f "$ca_path" ]; then
            cp "$ca_path" "$SSL_DIR/ca.pem"
            echo "✓ CA bundle copied"
        fi

        echo ""
        echo "✓ Certificate files copied successfully!"
        echo "  Certificate: $SSL_DIR/cert.pem"
        echo "  Private Key: $SSL_DIR/key.pem"
        ;;

    4)
        echo "Exiting..."
        exit 0
        ;;

    *)
        echo "❌ Invalid choice"
        exit 1
        ;;
esac

# Set secure permissions
print_section "Setting File Permissions"
chmod 600 "$SSL_DIR"/*.pem
echo "✓ Set secure permissions (600) on certificate files"

# Verify certificates
print_section "Verifying Certificates"

if ! openssl x509 -in "$SSL_DIR/cert.pem" -text -noout > /dev/null 2>&1; then
    echo "❌ Certificate file appears to be invalid"
    exit 1
fi
echo "✓ Certificate file is valid"

if ! openssl rsa -in "$SSL_DIR/key.pem" -check > /dev/null 2>&1; then
    # Try other key formats
    if ! openssl ec -in "$SSL_DIR/key.pem" -check > /dev/null 2>&1; then
        echo "❌ Private key file appears to be invalid"
        exit 1
    fi
fi
echo "✓ Private key file is valid"

# Show certificate details
echo ""
echo "Certificate Details:"
openssl x509 -in "$SSL_DIR/cert.pem" -noout -subject -issuer -dates

# Environment configuration
print_section "Environment Configuration"
echo "Add the following to your .env file:"
echo ""
echo "  DOMAIN=your-domain.com          # Your domain name"
echo "  PRODUCTION_MODE=true            # Enable production mode"
echo "  # BASE_URL=https://your-domain.com  # Optional: explicit BASE_URL"
echo ""

# Final instructions
print_section "Next Steps"
echo "1. Configure your .env file with the settings above"
echo "2. Build the project: npm run build"
echo "3. Start the server: npm start"
echo ""
echo "The server will automatically:"
echo "  ✓ Detect SSL certificates in .ssl/ directory"
echo "  ✓ Start HTTPS server on port 443"
echo "  ✓ Start HTTP redirect server on port 80"
echo "  ✓ Configure BASE_URL to use https://"
echo ""
echo "⚠️  Important:"
echo "  - Ports 80 and 443 require root privileges"
echo "  - Run with: sudo npm start"
echo "  - Or grant capabilities: sudo setcap cap_net_bind_service=+ep \$(which node)"
echo "  - Or use nginx reverse proxy (recommended for production)"
echo ""
echo "For more information, see: packages/backend/HTTPS_SETUP.md"
echo ""
echo "✓ SSL setup complete!"
