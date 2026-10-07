#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/server.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if ps -p "$PID" > /dev/null 2>&1; then
    echo "Stopping DSH Q20 Web service (PID: $PID)..."
    kill "$PID" || kill -9 "$PID"
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# Also clean up any orphan server.mjs running from this directory
pkill -f "node server.mjs" 2>/dev/null || true
echo "DSH Q20 Web service stopped."
