# openclaw-smartlead

Smartlead reply-webhook ingress adapter for OpenClaw.

This plugin is intentionally narrow:

1. It exposes a Smartlead webhook endpoint (default `/smartlead/webhook`).
2. It validates + parses + deduplicates Smartlead `EMAIL_REPLY` events.
3. It forwards a normalized JSON payload to an OpenClaw mapped hook (default `/hooks/smartlead`).

Prompting, delivery routing, and branching logic should live in OpenClaw `hooks.mappings` / hook transforms.

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

## Architecture (recommended)

Flow:

- Smartlead -> `POST /smartlead/webhook` (plugin route)
- `openclaw-smartlead` plugin -> validates secret, normalizes payload, dedupes retries
- Plugin -> `POST /hooks/smartlead` (OpenClaw native hook endpoint, with hook token auth)
- OpenClaw `hooks.mappings` -> builds prompt / routes agent / optional branching transform
- Agent uses `smartlead` CLI to fetch message history and summarize thread

## OpenClaw Hooks Prerequisite

Because this plugin forwards Smartlead events to an OpenClaw mapped hook (`/hooks/smartlead` by default), enable webhook hooks in your OpenClaw config:

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    path: "/hooks",
    allowedAgentIds: ["*"],
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,

    // Smartlead workflow lives here now (generic OpenClaw hook mappings).
    mappings: [
      {
        id: "smartlead-reply",
        match: { path: "smartlead", source: "smartlead" },
        action: "agent",
        wakeMode: "now",
        name: "Smartlead Reply",

        // Keep one isolated session per lead thread (customize if needed).
        sessionKey: "hook:smartlead:{{campaign_id}}:{{lead_id}}",

        // Default behavior (can be replaced with transform-based branching).
        messageTemplate:
          "New lead answer\\n" +
          "Campaign: {{campaign_name}} (ID {{campaign_id}})\\n" +
          "Lead: {{lead_email}}\\n" +
          "Responder: {{responder_email}}\\n" +
          "Reply category: {{reply_category}}\\n" +
          "Preview: {{preview_text}}\\n\\n" +
          "Use smartlead CLI to fetch conversation history and summarize it.\\n" +
          "If lead_id exists: smartlead campaigns leads message-history {{campaign_id}} {{lead_id}}\\n" +
          "If lead_id is missing and lead_email exists: smartlead leads get-by-email --email {{lead_email}}",

        deliver: true,
        channel: "slack"
        // to: "C0123456789"
      }
    ]
  }
}
```

The plugin can auto-derive the mapped hook URL (`/hooks/smartlead`) and token from this config.

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
          webhookSecret: "optional-smartlead-secret",

          // Optional overrides (normally auto-derived from OpenClaw hooks config)
          openclawHookUrl: "http://127.0.0.1:18789/hooks/smartlead",
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
- `openclawHookUrl` and `openclawHookToken` are usually auto-derived from OpenClaw `gateway` / `hooks` config.
- Delivery channel, `agentId`, prompt text, and branching now belong in `hooks.mappings` (OpenClaw config), not plugin config.
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

## What The Plugin Forwards To `/hooks/smartlead`

The plugin forwards normalized JSON (not a prebuilt prompt) so OpenClaw `hooks.mappings` can template/branch on it.

The forwarded payload includes:

- `source: "smartlead"` (for `match.source`)
- Flat aliases (easy template access):
  - `campaign_id`, `campaign_name`, `campaign_status`
  - `lead_id`, `lead_map_id`, `lead_email`
  - `responder_email`, `responder_name`, `target_name`
  - `reply_category`, `replied_company_domain`
  - `subject`, `preview_text`, `event_timestamp`
  - `message_id`, `sequence_number`, `stats_id`, `app_url`
- `context` (same data grouped)
- `payloadSummary` (presence/keys hints)
- `payload` (sanitized raw Smartlead payload; `secret_key` redacted)

This makes branching via hook transforms practical (for example: positive reply vs decline vs OOO).

## Optional Branching Transform (recommended for production)

Use a hook transform to keep deterministic branching out of the plugin. Example mapping:

```json5
{
  hooks: {
    mappings: [
      {
        id: "smartlead-reply",
        match: { path: "smartlead", source: "smartlead" },
        action: "agent",
        wakeMode: "now",
        name: "Smartlead Reply",
        sessionKey: "hook:smartlead:{{campaign_id}}:{{lead_id}}",
        deliver: true,
        channel: "slack",
        transform: { module: "smartlead-reply-branch.js" }
      }
    ]
  }
}
```

See `examples/hooks-transforms/smartlead-reply-branch.example.js` in this repo for a starter transform.
Copy it into your OpenClaw transforms directory (typically `~/.openclaw/hooks/transforms/`)
before referencing it in `hooks.mappings[].transform.module`.

## Reply Webhook Flow (What happens)

When Smartlead sends an `EMAIL_REPLY` webhook to `inboundWebhookPath`, the plugin:

1. Validates and parses the payload.
2. Deduplicates retries (TTL cache).
3. Forwards normalized JSON to OpenClaw `/hooks/smartlead` (or your configured mapped hook URL).
4. OpenClaw `hooks.mappings` (and optional transforms) decide:
   - prompt text
   - delivery channel/target
   - branching behavior
5. The agent uses `smartlead` CLI to fetch message history and summarize the thread.

## Final Usage Example (your target flow)

Resulting behavior after setup:

- Lead replies to campaign email in Smartlead
- Smartlead calls `POST /smartlead/webhook`
- Plugin forwards normalized payload to `POST /hooks/smartlead`
- OpenClaw mapping runs an isolated hook agent turn
- OpenClaw sends a message to your configured channel with:
  - `New lead answer`
  - a short summary of prior conversation (fetched from Smartlead message history)

## Bundled Skill

The plugin ships a bundled skill at `skills/smartlead/SKILL.md` so the LLM can operate Smartlead reliably (ID handling, webhook payload fields, CLI usage, and reply-workflow guidance).
