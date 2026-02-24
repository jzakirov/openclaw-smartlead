# openclaw-smartlead

Smartlead reply-webhook bridge for OpenClaw.

This plugin is intentionally narrow:

1. It exposes a webhook endpoint for Smartlead campaign webhooks.
2. It forwards `EMAIL_REPLY` events to OpenClaw `/hooks/agent`.
3. The agent then uses the `smartlead` CLI (and bundled skill) to fetch thread history and post a summary.

It does not call Smartlead API directly and it does not register Smartlead API tools inside the plugin runtime.

## npm Package

Published package name (configured for releases): `@jzakirov/smartlead`

## Installation

From local path (dev/link):

```bash
openclaw plugins install -l /home/worker/code/openclaw-smartlead
openclaw plugins enable smartlead
```

Or copy install:

```bash
openclaw plugins install /home/worker/code/openclaw-smartlead
openclaw plugins enable smartlead
```

## OpenClaw Hooks Prerequisite

Because this plugin forwards Smartlead events to OpenClaw `/hooks/agent`, enable webhook hooks in your OpenClaw config:

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    path: "/hooks",
    allowedAgentIds: ["*"]
  }
}
```

The plugin can usually auto-derive `/hooks/agent` URL and hook token from this OpenClaw config.

## Plugin Configuration

Configure under `plugins.entries.smartlead.config`:

### Minimal setup (recommended)

```json5
{
  plugins: {
    entries: {
      smartlead: {
        enabled: true,
        config: {
          hookChannel: "slack",
          webhookSecret: "optional-smartlead-secret"
        }
      }
    }
  }
}
```

### Common optional overrides

Most setups do not need these. Only set them when OpenClaw cannot auto-derive values.

```json5
{
  plugins: {
    entries: {
      smartlead: {
        enabled: true,
        config: {
          hookChannel: "slack",
          hookAgentId: "main",
          webhookSecret: "optional-smartlead-secret",

          // Optional overrides (normally auto-derived from OpenClaw config)
          openclawAgentHookUrl: "http://127.0.0.1:18789/hooks/agent",
          openclawHookToken: "${OPENCLAW_HOOKS_TOKEN}",

          // Optional path override (default: /smartlead/webhook)
          inboundWebhookPath: "/smartlead/webhook"
        }
      }
    }
  }
}
```

Notes

- `webhookSecret` is optional. If set, the plugin validates it against Smartlead payload `secret_key` (and also `Authorization`, `x-smartlead-secret`, and `x-webhook-secret` headers).
- `openclawAgentHookUrl` and `openclawHookToken` are usually auto-derived from OpenClaw `gateway` / `hooks` config.
- `hookChannel` is the main field most users care about for reply alerts.
- The plugin currently accepts `EMAIL_REPLY` webhooks (reply flow). Other Smartlead webhook event types are ignored.

## Smartlead Webhook Setup (Campaign)

Smartlead campaign webhook endpoints (per Smartlead docs):

- `GET /campaigns/<campaign-id>/webhooks`
- `POST /campaigns/<campaign-id>/webhooks` (add/update)

Example Smartlead webhook registration body (via Smartlead UI or `smartlead` CLI):

```json
{
  "id": null,
  "name": "OpenClaw Reply Alerts",
  "webhook_url": "https://your-openclaw-host.example.com/smartlead/webhook",
  "event_types": ["EMAIL_REPLY"],
  "categories": ["Interested"]
}
```

Important:

- `categories` must be a non-empty array in Smartlead webhook upsert requests.
- `categories` values are Smartlead lead category labels from your workspace (for example `Interested`), not webhook event types.
- Use `smartlead webhooks upsert --help` for the current `event_types` enum supported by the CLI.

## Reply Webhook Flow (What happens)

When Smartlead sends an `EMAIL_REPLY` webhook to `inboundWebhookPath`, the plugin:

1. Validates and parses the payload.
2. Deduplicates retries (TTL cache).
3. Forwards a prompt to OpenClaw `/hooks/agent`.
4. The agent is instructed to:
   - Send a message starting with `New lead answer`
   - Use the `smartlead` CLI to fetch message history
   - Summarize prior conversation with the lead

## Final Usage Example (your target flow)

Resulting behavior after setup:

- Lead replies to campaign email in Smartlead
- Smartlead calls `POST /smartlead/webhook`
- OpenClaw runs an isolated hook agent turn
- OpenClaw sends a message to your configured channel with:
  - `New lead answer`
  - a short summary of prior conversation (fetched from Smartlead message history)

## Bundled Skill

The plugin ships a bundled skill at `skills/smartlead/SKILL.md` so the LLM can operate Smartlead reliably (ID handling, webhook payload fields, CLI usage, and reply-workflow guidance).
