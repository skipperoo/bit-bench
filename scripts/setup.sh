#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SECRETS_DIR="$PROJECT_DIR/secrets"

echo "=== BitBench Setup ==="
echo ""

# Initialize git submodules (needed for C++ compression libs)
if [ -f "$PROJECT_DIR/.gitmodules" ]; then
    echo "Initializing git submodules..."
    cd "$PROJECT_DIR"
    git submodule update --init --recursive 2>/dev/null || echo "  (some submodules may be unavailable)"
    echo ""
fi

# Create secrets directory
mkdir -p "$SECRETS_DIR"

# Generate secrets if they don't exist
if [ ! -f "$SECRETS_DIR/jwt_secret.txt" ]; then
    echo "Generating JWT secret..."
    openssl rand -hex 32 > "$SECRETS_DIR/jwt_secret.txt"
    echo "  -> $SECRETS_DIR/jwt_secret.txt"
fi

if [ ! -f "$SECRETS_DIR/db_password.txt" ]; then
    echo "Generating database password..."
    openssl rand -base64 24 > "$SECRETS_DIR/db_password.txt"
    echo "  -> $SECRETS_DIR/db_password.txt"
fi

if [ ! -f "$SECRETS_DIR/redis_password.txt" ]; then
    echo "Generating Redis password..."
    openssl rand -base64 24 > "$SECRETS_DIR/redis_password.txt"
    echo "  -> $SECRETS_DIR/redis_password.txt"
fi

if [ ! -f "$SECRETS_DIR/smtp_password.txt" ]; then
    echo "Generating SMTP password (placeholder)..."
    echo "change-me" > "$SECRETS_DIR/smtp_password.txt"
    echo "  -> $SECRETS_DIR/smtp_password.txt"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Secrets generated in: $SECRETS_DIR"
echo ""
echo "To start the application:"
echo "  docker compose up -d"
echo ""
echo "Default admin credentials:"
echo "  Email:    admin@bitbench.org"
echo "  Password: changeme"
echo ""
echo "IMPORTANT: Change the admin password after first login."
echo ""
echo "Access:"
echo "  Main app:  http://localhost"
echo "  Admin:     http://localhost:81"
