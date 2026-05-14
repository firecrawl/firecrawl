#!/usr/bin/env sh
set -e

# Start Node app in background
node dist/index.js &
APP_PID=$!

# Start NGINX in foreground
nginx -g 'daemon off;'

wait $APP_PID


