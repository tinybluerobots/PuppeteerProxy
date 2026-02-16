#!/bin/bash
set -e

if [ -z "$DESTINATION" ]; then
    echo "Error: DESTINATION environment variable not set. Usage: DESTINATION=hostname ./install.sh" >&2
    exit 1
fi

echo "Building puppeteerproxy..."
bun build ./index.ts --compile --outfile puppeteerproxy

echo "Installing system dependencies on remote server..."
ssh root@"$DESTINATION" 'command -v npx >/dev/null || (apt update && apt install -y npm)' || {
    echo "Warning: Failed to install npm, continuing..." >&2
}

echo "Installing Chrome browser on remote server..."
ssh root@"$DESTINATION" 'npx puppeteer@latest browsers install chrome' || {
    echo "Warning: Failed to install Chrome, continuing..." >&2
}

echo "Stopping existing service..."
ssh root@"$DESTINATION" 'systemctl stop puppeteerproxy.service' 2>/dev/null || {
    echo "Service not running or doesn't exist yet, continuing..."
}

echo "Copying service file..."
scp puppeteerproxy.service root@"$DESTINATION":/etc/systemd/system

echo "Copying binary..."
scp puppeteerproxy root@"$DESTINATION":/opt

echo "Starting service..."
ssh root@"$DESTINATION" 'systemctl daemon-reload && systemctl enable puppeteerproxy.service && systemctl start puppeteerproxy.service'