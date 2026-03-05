// Copy this file into your OpenClaw transforms dir (for example:
// ~/.openclaw/hooks/transforms/smartlead-reply-branch.js)
// and reference it from hooks.mappings[].transform.module.
//
// Incoming ctx payload shape comes from openclaw-smartlead plugin forwarding to /hooks/smartlead.
// Useful fields:
// - ctx.payload.campaign_id
// - ctx.payload.lead_id
// - ctx.payload.lead_email
// - ctx.payload.reply_category
// - ctx.payload.preview_text
// - ctx.payload.subject
// - ctx.payload.app_url
// - ctx.payload.payload (sanitized raw Smartlead payload)

function lower(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function branchFromPayload(payload) {
  const category = lower(payload.reply_category);
  const preview = lower(payload.preview_text);

  if (category.includes("interested")) return "positive";
  if (category.includes("meeting")) return "positive";
  if (category.includes("not interested")) return "negative";
  if (category.includes("uninterested")) return "negative";
  if (category.includes("out of office")) return "ooo";

  if (/\bnot interested\b|\bno thanks\b|\bremove me\b/.test(preview)) return "negative";
  if (/\bout of office\b|\booo\b|\bvacation\b/.test(preview)) return "ooo";
  if (/\binterested\b|\bsounds good\b|\blet'?s talk\b|\bbook\b/.test(preview)) return "positive";

  return "neutral";
}

export default function transform(ctx) {
  const p = (ctx && ctx.payload) || {};
  const branch = branchFromPayload(p);

  const campaignId = p.campaign_id ?? "unknown";
  const leadId = p.lead_id ?? "unknown";
  const leadEmail = p.lead_email || "unknown";
  const preview = p.preview_text || "";
  const campaignName = p.campaign_name || "";
  const replyCategory = p.reply_category || "";

  const lines = [
    "New lead answer",
    `Branch: ${branch}`,
    `Campaign: ${campaignName} (${campaignId})`,
    `Lead: ${leadEmail}`,
    `Reply category: ${replyCategory}`,
    `Preview: ${preview}`,
    "",
    "Fetch the full Smartlead thread and summarize it before taking action.",
    "",
    p.lead_id != null
      ? `smartlead campaigns leads message-history ${campaignId} ${leadId}`
      : `smartlead leads get-by-email --email ${JSON.stringify(leadEmail)}`,
    "",
    "Then:",
    "- Summarize previous conversation",
    "- If branch=positive: propose next step and notify channel",
    "- If branch=negative: notify channel and suggest marking status/category",
    "- If branch=ooo: notify channel and suggest follow-up timing",
  ];

  return {
    kind: "agent",
    name: "Smartlead Reply",
    wakeMode: "now",
    message: lines.join("\n"),
    deliver: true,
    channel: "last",
  };
}

