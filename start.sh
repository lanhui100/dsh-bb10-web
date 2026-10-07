#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PORT:-3090}"
HOST="${HOST:-0.0.0.0}"
DSH_ROOT="${DSH_ROOT:-$DIR/../deepseek-harness}"
PID_FILE="$DIR/server.pid"
LOG_FILE="$DIR/server.log"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if ps -p "$OLD_PID" > /dev/null 2>&1; then
    echo "DSH Q20 Web service is already running (PID: $OLD_PID) at http://$HOST:$PORT"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# Port preflight: refuse to fork a second listener on the same port (PID file
# alone cannot catch systemd-managed / manually started siblings).
if ss -tln 2>/dev/null | grep -qE "[:.]${PORT}($| )"; then
  echo "Error: port ${PORT} already has a listener (ss -tln). Refusing to start a second instance."
  echo "  Diagnose: ss -tlnp | grep ${PORT}"
  echo "  Cleanup:  ./stop.sh (or: sudo systemctl stop dsh-q20-web)"
  exit 1
fi

# Ensure DSH_ROOT exists
if [ ! -d "$DSH_ROOT" ]; then
  echo "Error: DSH_ROOT directory not found: $DSH_ROOT"
  exit 1
fi

echo "Starting DSH Q20 Web service..."
echo "  DSH_ROOT: $DSH_ROOT"
echo "  URL:      http://$HOST:$PORT"
echo "  Log:      $LOG_FILE"

export PORT
export HOST
export DSH_ROOT

nohup node server.mjs > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 1
if ps -p "$NEW_PID" > /dev/null 2>&1; then
  echo "DSH Q20 Web service started successfully! (PID: $NEW_PID)"
else
  echo "Error: Failed to start service. Check $LOG_FILE for details:"
  tail -n 20 "$LOG_FILE"
  exit 1
fi
