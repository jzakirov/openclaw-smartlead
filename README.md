# openclaw-smartlead

Smartlead API + webhook automation plugin for OpenClaw.

This plugin does two things:

1. Registers Smartlead tools for lead lookup, message history, campaign webhooks, and raw API requests.
2. Exposes a plugin HTTP route that accepts Smartlead reply webhooks and forwards them into OpenClaw `/hooks/agent` so the agent can notify a chat channel and summarize the prior thread.

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

## Plugin Configuration

Configure under `plugins.entries.smartlead.config`:

```json5
{
  plugins: {
    entries: {
      smartlead: {
        enabled: true,
        config: {
          apiKey: "${SMARTLEAD_API_KEY}",
          apiBaseUrl: "https://server.smartlead.ai/api/v1",

          inboundWebhookPath: "/smartlead/webhook",
          webhookSecret: "optional-smartlead-secret-key",

          openclawAgentHookUrl: "http://127.0.0.1:18789/hooks/agent",
          openclawHookToken: "${OPENCLAW_HOOKS_TOKEN}",

          hookName: "Smartlead",
          hookAgentId: "main",
          hookChannel: "slack",
          hookTo: "C0123456789",
          hookWakeMode: "now",
          hookDeliver: true,

          replyEventTypes: ["EMAIL_REPLY"]
        }
      }
    }
  }
}
```

Notes:

- `webhookSecret` is optional. If set, the plugin validates it against Smartlead payload `secret_key` (and also `x-smartlead-secret` / `?token=` as fallbacks).
- `openclawAgentHookUrl` should usually be your local gateway `/hooks/agent` URL.

## Smartlead Webhook Setup (Campaign)

Smartlead campaign webhook endpoints (per Smartlead docs):

- `GET /campaigns/<campaign-id>/webhooks`
- `POST /campaigns/<campaign-id>/webhooks` (add/update)

Example Smartlead webhook registration body (via API or Smartlead UI/API tooling):

```json
{
  "id": null,
  "name": "OpenClaw Reply Alerts",
  "webhook_url": "https://your-openclaw-host.example.com/smartlead/webhook",
  "event_types": ["EMAIL_REPLY"],
  "categories": []
}
```

You can also use the plugin tool:

```text
smartlead_upsert_campaign_webhook(campaign_id=9181, body={...})
```

## Tools

- `smartlead_list_campaigns`
- `smartlead_get_lead_by_email`
- `smartlead_get_campaign_lead_message_history`
- `smartlead_list_campaign_webhooks`
- `smartlead_upsert_campaign_webhook`
- `smartlead_delete_campaign_webhook`
- `smartlead_raw_request`

## Reply Webhook Flow (What happens)

When Smartlead sends an `EMAIL_REPLY` webhook to `inboundWebhookPath`, the plugin:

1. Validates and parses the payload.
2. Deduplicates retries (TTL cache).
3. Forwards a prompt to OpenClaw `/hooks/agent`.
4. The agent is instructed to:
   - Send a message starting with `New lead answer`
   - Call Smartlead tools (especially message history)
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

The plugin ships a bundled skill at `skills/smartlead/SKILL.md` so the LLM can operate Smartlead more reliably (IDs, webhook payload fields, tool selection, and reply-workflow guidance).
