#!/usr/bin/env bash
# openclaw-smartlead setup — installs smartlead-cli and prints configuration snippets
#
# Usage:
#   ./setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "📬  Setting up openclaw-smartlead..."
echo ""

# ─── Install smartlead-cli ────────────────────────────────────────────────────

echo "Installing smartlead-cli from PyPI..."
if command -v uv &>/dev/null; then
  uv tool install smartlead-cli
elif command -v pip3 &>/dev/null; then
  pip3 install --user smartlead-cli
elif command -v pip &>/dev/null; then
  pip install --user smartlead-cli
else
  echo "❌  No Python package manager found (uv, pip3, pip). Install one first."
  exit 1
fi

if ! command -v smartlead &>/dev/null; then
  echo "❌  'smartlead' binary not found after install. Make sure ~/.local/bin is in your PATH."
  echo "   Add to ~/.bashrc or ~/.zshrc:  export PATH=\"\$HOME/.local/bin:\$PATH\""
  exit 1
fi

echo "✅  smartlead-cli installed: $(smartlead --version 2>/dev/null || echo 'ok')"
echo ""

# ─── Configure credentials ────────────────────────────────────────────────────

echo "Configure Smartlead credentials (one-time):"
echo "  export SMARTLEAD_API_KEY=your_api_key"
echo "  smartlead config init"
echo ""
echo "Or set directly:"
echo "  smartlead config set core.api_key \$SMARTLEAD_API_KEY"
echo ""
echo "Verify:"
echo "  smartlead campaigns list"
echo ""

# ─── Install openclaw plugin ──────────────────────────────────────────────────

echo "Installing openclaw plugin..."
if command -v openclaw &>/dev/null; then
  if openclaw plugins install "$SCRIPT_DIR" 2>/dev/null; then
    echo "✅  Plugin installed from $SCRIPT_DIR"
  else
    echo "⚠️   'openclaw plugins install' failed. Add manually to your openclaw config:"
    echo "   plugins.loadPaths: [\"$SCRIPT_DIR\"]"
  fi
else
  echo "⚠️   openclaw not found. Add plugin manually to your openclaw config:"
  echo "   plugins.loadPaths: [\"$SCRIPT_DIR\"]"
fi
echo ""

# ─── Detect gateway settings ─────────────────────────────────────────────────

GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
HOOKS_PATH="${OPENCLAW_HOOKS_PATH:-/hooks}"
GATEWAY_HOST="${OPENCLAW_GATEWAY_HOST:-127.0.0.1}"
WEBHOOK_PATH="/smartlead/webhook"

# ─── Print openclaw config snippet ───────────────────────────────────────────

echo "══════════════════════════════════════════════════════════════════════════"
echo "Step 1 — Enable hooks in your openclaw config (~/.openclaw/config.json)"
echo "══════════════════════════════════════════════════════════════════════════"
cat <<JSON
{
  "hooks": {
    "enabled": true,
    "token": "<generate with: openssl rand -hex 32>",
    "path": "${HOOKS_PATH}"
  },
  "plugins": {
    "enabled": true,
    "allow": ["smartlead"]
  }
}
JSON
echo ""
echo "⚠️   hooks.token is REQUIRED. The plugin auto-derives the hook URL and"
echo "    token from this config — no extra plugin config needed for defaults."
echo ""
echo "Optional: to use a deterministic session key per event (useful for"
echo "de-duplication across restarts), also add:"
echo '  "allowRequestSessionKey": true'
echo '  "allowedSessionKeyPrefixes": ["hook:"]'
echo ""

# ─── Plugin config (if overrides needed) ─────────────────────────────────────

echo "══════════════════════════════════════════════════════════════════════════"
echo "Step 2 — Plugin config (only needed to override defaults)"
echo "══════════════════════════════════════════════════════════════════════════"
echo ""
echo "Add under plugins.entries.smartlead.config if you need to override:"
cat <<JSON
{
  "plugins": {
    "entries": {
      "smartlead": {
        "enabled": true,
        "config": {
          "hookChannel": "telegram",
          "webhookSecret": "<optional: set same value in Smartlead>",
          "replyEventTypes": ["EMAIL_REPLY"]
        }
      }
    }
  }
}
JSON
echo ""
echo "Default webhook path: ${WEBHOOK_PATH}"
echo "Hook URL is auto-derived: http://${GATEWAY_HOST}:${GATEWAY_PORT}${HOOKS_PATH}/agent"
echo ""

# ─── Smartlead webhook setup ──────────────────────────────────────────────────

echo "══════════════════════════════════════════════════════════════════════════"
echo "Step 3 — Configure Smartlead to forward EMAIL_REPLY events"
echo "══════════════════════════════════════════════════════════════════════════"
echo ""
echo "Your openclaw gateway must be reachable from the internet."
echo "Options:"
echo "  • Tailscale (self-hosted, recommended)"
echo "  • ngrok:     ngrok http ${GATEWAY_PORT}"
echo "  • Cloudflare Tunnel / any reverse proxy"
echo ""
echo "Once you have a public URL, register the webhook via CLI:"
echo ""
cat <<'CMD'
  # First find your campaign ID:
  smartlead campaigns list

  # Then register the webhook (replace <campaign_id> and <public-url>):
  smartlead webhooks upsert <campaign_id> --body-json '{
    "id": null,
    "name": "OpenClaw Reply Alerts",
    "webhook_url": "https://<public-url>/smartlead/webhook",
    "event_types": ["EMAIL_REPLY"],
    "categories": []
  }'
CMD
echo ""

# ─── Smoke test ───────────────────────────────────────────────────────────────

echo "══════════════════════════════════════════════════════════════════════════"
echo "Step 4 — Verify (after restarting openclaw)"
echo "══════════════════════════════════════════════════════════════════════════"
echo ""
echo "# Health check — should return {\"ok\":true,\"plugin\":\"smartlead\",...}:"
echo "  curl -s http://${GATEWAY_HOST}:${GATEWAY_PORT}${WEBHOOK_PATH}"
echo ""
echo "# Send a test EMAIL_REPLY event:"
cat <<CURL
  curl -s -X POST http://${GATEWAY_HOST}:${GATEWAY_PORT}${WEBHOOK_PATH} \\
    -H 'Content-Type: application/json' \\
    -d '{
      "event_type": "EMAIL_REPLY",
      "campaign_id": 12345,
      "sl_email_lead_id": 98765,
      "sl_lead_email": "lead@example.com",
      "subject": "Re: Your proposal",
      "preview_text": "Thanks for reaching out, happy to chat.",
      "event_timestamp": "2025-01-15T10:30:00Z"
    }'
CURL
echo ""
echo "Expected response: {\"ok\":true, \"event_type\":\"EMAIL_REPLY\", ...}"
echo ""
echo "✅  Setup complete. Restart openclaw to activate the plugin."
