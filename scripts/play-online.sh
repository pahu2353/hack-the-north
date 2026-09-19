#!/usr/bin/env bash
# Puts Jev Commander online in one go: opens a Cloudflare quick tunnel, starts the game server
# with the tunnel's public address (so invite links use it), and prints the links.
# Ctrl+C stops both, and the public link stops working.
#
# Usage: npm run online        (PORT=3001 npm run online to use another port; OPEN=0 to skip the browser)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
LOG_DIR="$(mktemp -d)"
TUNNEL_LOG="$LOG_DIR/tunnel.log"

fail() {
  echo "✗ $*" >&2
  exit 1
}

# ---------- checks ----------
command -v node >/dev/null || fail "Node.js isn't installed (need 22.18 or later)."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' \
  || fail "Node $(node -v) is too old: this project needs 22.18 or later."
command -v cloudflared >/dev/null || fail "cloudflared isn't installed. Install it with: brew install cloudflared"
[ -d node_modules ] || { echo "Installing dependencies…"; npm install; }
{ [ -f .env.local ] && grep -q '^AI_GATEWAY_API_KEY=.' .env.local; } \
  || fail "Add AI_GATEWAY_API_KEY=... to .env.local first (see the README)."
grep -q '^DEEPGRAM_API_KEY=.' .env.local \
  || echo "! No DEEPGRAM_API_KEY in .env.local: voice orders won't work (typing and hand signals still will)."
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port $PORT is already in use. Is the game already running (e.g. npm run dev)? Stop it, or run: PORT=3001 npm run online"
fi

# Background jobs ignore Ctrl+C in scripts, so stop them explicitly on the way out.
cleanup() {
  kill "${SERVER_PID:-}" "${TUNNEL_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$LOG_DIR"
  echo
  echo "Stopped. The public link no longer works."
}
trap cleanup EXIT
trap 'exit 0' INT TERM

# ---------- tunnel first, so the server can be told its public address ----------
echo "Opening a Cloudflare tunnel…"
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { cat "$TUNNEL_LOG" >&2; fail "cloudflared exited early."; }
  sleep 0.5
done
[ -n "$PUBLIC_URL" ] || { cat "$TUNNEL_LOG" >&2; fail "Timed out waiting for the tunnel's address."; }

# ---------- game server ----------
PUBLIC_URL="$PUBLIC_URL" PORT="$PORT" node --env-file-if-exists=.env.local server.ts &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null "http://localhost:$PORT/commander/" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "The game server didn't start (see the error above)."
  sleep 0.25
done

cat <<EOF

  ✅ Jev Commander is online

     You:      http://localhost:$PORT/commander/
     Friends:  $PUBLIC_URL/commander/

  Click Multiplayer → Create game and send the invite link. It already uses the public address.
  A brand-new public link can take a minute to start working.
  Anyone with the link can use your Jev and Deepgram credits.
  Press Ctrl+C to stop.

EOF
if [ "${OPEN:-1}" = 1 ] && command -v open >/dev/null; then open "http://localhost:$PORT/commander/"; fi
wait "$SERVER_PID"
