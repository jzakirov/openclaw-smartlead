---
name: smartlead
description: "Use the openclaw-smartlead plugin to work with Smartlead campaigns/leads/webhooks and to handle Smartlead EMAIL_REPLY webhook automations. Use when you need Smartlead lead lookup, message history, campaign webhook setup, or reply-event triage/summaries."
metadata:
  {
    "openclaw":
      {
        "emoji": "📬",
        "requires": { "env": ["SMARTLEAD_API_KEY"] },
        "primaryEnv": "SMARTLEAD_API_KEY"
      }
  }
---

# Smartlead (OpenClaw Plugin)

This skill assumes the `openclaw-smartlead` plugin is installed/enabled and its tools are available.

## Tool Selection

- `smartlead_get_campaign_lead_message_history`:
  Use first when you already have `campaign_id` + `lead_id` and need prior email thread context.

- `smartlead_get_lead_by_email`:
  Use when webhook/event data has an email but no reliable lead ID.

- `smartlead_list_campaign_webhooks` / `smartlead_upsert_campaign_webhook` / `smartlead_delete_campaign_webhook`:
  Use for Smartlead campaign webhook management.

- `smartlead_raw_request`:
  Fallback for unsupported Smartlead endpoints (path is relative to `/api/v1`).

## Smartlead Reply Webhook Payload (important)

For Smartlead reply webhooks, expect `event_type: "EMAIL_REPLY"` and fields like:

- `campaign_id`
- `sl_email_lead_id` (lead id)
- `sl_email_lead_map_id` (lead map id)
- `sl_lead_email`
- `subject`
- `preview_text`
- `event_timestamp`
- `secret_key`
- `leadCorrespondence.targetLeadEmail`
- `leadCorrespondence.replyReceivedFrom`
- `leadCorrespondence.repliedCompanyDomain`

Prefer these semantics:

- Original targeted lead email: `leadCorrespondence.targetLeadEmail` (fallback `sl_lead_email`)
- Actual responder: `leadCorrespondence.replyReceivedFrom`

## Reply Alert Workflow (target behavior)

When handling a Smartlead `EMAIL_REPLY` event:

1. Confirm `campaign_id` and `lead_id` (usually `sl_email_lead_id`).
2. Call `smartlead_get_campaign_lead_message_history(campaign_id, lead_id)`.
3. Summarize the prior conversation context.
4. Send a concise alert starting with exactly `New lead answer`.
5. Include responder vs target-lead distinction when they differ.

If `lead_id` is missing:

1. Resolve by email with `smartlead_get_lead_by_email`.
2. If campaign-specific ID still cannot be resolved, summarize from webhook payload only and state the limitation.

## Campaign Webhook Setup Pattern

Use `smartlead_upsert_campaign_webhook` with a body similar to:

```json
{
  "id": null,
  "name": "OpenClaw Reply Alerts",
  "webhook_url": "https://your-openclaw-host.example.com/smartlead/webhook",
  "event_types": ["EMAIL_REPLY"],
  "categories": []
}
```

`id: null` creates a new webhook. Set `id` to update an existing webhook.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Using `sl_email_lead_map_id` as `lead_id` for message history | Use `sl_email_lead_id` first |
| Treating `replyReceivedFrom` as the original lead | Use `targetLeadEmail` as original target |
| Calling raw endpoints before trying specific tools | Prefer specific tools for reliability |
| Forgetting Smartlead auth | Ensure `SMARTLEAD_API_KEY` (or plugin config `apiKey`) is set |

## Setup

Use `skills/smartlead/setup.sh` to install/link the plugin and print configuration snippets.
