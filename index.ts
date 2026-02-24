// openclaw-smartlead plugin
// Registers one HTTP route that receives Smartlead webhook events and forwards
// EMAIL_REPLY events to the openclaw /hooks/agent endpoint.
// All Smartlead API interaction is done by the agent via the `smartlead` CLI.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type JsonObject = Record<string, unknown>;

type SmartleadPluginConfig = {
  webhookSecret?: string;          // validate incoming Smartlead webhooks
  hookChannel?: string;            // delivery channel (e.g. "telegram")
  hookAgentId?: string;            // optional: route to a specific agent
  // override-only (auto-derived from api.config by default)
  openclawAgentHookUrl?: string;
  openclawHookToken?: string;
  inboundWebhookPath?: string;
};

const DEFAULT_INBOUND_WEBHOOK_PATH = "/smartlead/webhook";
const REPLY_EVENT_TYPES = ["EMAIL_REPLY"];
const DEDUPE_TTL_MS = 15 * 60 * 1000;
const HOOK_FORWARD_TIMEOUT_MS = 10_000;
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

// In-process deduplication: keyed by event fingerprint, value = seen-at ms.
// Best-effort only — cleared on restart.
const seenWebhookEvents = new Map<string, number>();

// ─── Utilities ────────────────────────────────────────────────────────────────

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function firstNonEmpty(...values: unknown[]): string {
  for (const v of values) {
    const s = trimString(v);
    if (s) return s;
  }
  return "";
}

function normalizePath(path: string): string {
  const t = path.trim();
  if (!t) return "/";
  return t.startsWith("/") ? t : `/${t}`;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function getHeader(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? "";
  return typeof v === "string" ? v : "";
}

// ─── Config resolution ────────────────────────────────────────────────────────

function resolveWebhookPath(cfg: SmartleadPluginConfig): string {
  return normalizePath(
    trimString(cfg.inboundWebhookPath) ||
      trimString(process.env.SMARTLEAD_WEBHOOK_PATH) ||
      DEFAULT_INBOUND_WEBHOOK_PATH,
  );
}

function resolveWebhookSecret(cfg: SmartleadPluginConfig): string {
  return trimString(cfg.webhookSecret) || trimString(process.env.SMARTLEAD_WEBHOOK_SECRET);
}

// Tries to derive the hook URL from api.config (same gateway process) when not
// explicitly configured. This avoids the user having to duplicate port/path.
function resolveHookUrl(cfg: SmartleadPluginConfig, apiConfig: any): string {
  const explicit = trimString(cfg.openclawAgentHookUrl) || trimString(process.env.OPENCLAW_SMARTLEAD_AGENT_HOOK_URL);
  if (explicit) return explicit;
  const port = coerceNumber(apiConfig?.gateway?.port) ?? 18789;
  const hooksPath = trimString(apiConfig?.hooks?.path) || "/hooks";
  return `http://127.0.0.1:${port}${normalizePath(hooksPath)}/agent`;
}

// Tries to derive the hook token from api.config when not explicitly configured.
function resolveHookToken(cfg: SmartleadPluginConfig, apiConfig: any): string {
  return (
    trimString(cfg.openclawHookToken) ||
    trimString(process.env.OPENCLAW_HOOKS_TOKEN) ||
    trimString(apiConfig?.hooks?.token)
  );
}

// ─── Body reading ─────────────────────────────────────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;

  // 30-second read deadline to prevent slow-client hangs
  const timeout = setTimeout(() => req.destroy(new Error("body read timeout")), 30_000);

  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buf.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        throw new Error(`Payload too large (limit ${MAX_WEBHOOK_BODY_BYTES} bytes)`);
      }
      chunks.push(buf);
    }
  } finally {
    clearTimeout(timeout);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return asRecord(JSON.parse(raw));
}

// ─── Webhook payload extraction ───────────────────────────────────────────────

type ReplyWebhookContext = {
  eventType: string;
  campaignId?: number;
  leadId?: number;
  leadMapId?: number;
  leadEmail?: string;
  responderEmail?: string;
  subject?: string;
  previewText?: string;
  eventTimestamp?: string;
  statsId?: string;
  appUrl?: string;
  secretKey?: string;
  payload: JsonObject;
};

function extractReplyContext(payload: JsonObject): ReplyWebhookContext {
  const lc = asRecord(payload.leadCorrespondence);
  return {
    eventType: firstNonEmpty(payload.event_type, payload.eventType, payload.type).toUpperCase(),
    campaignId: coerceNumber(payload.campaign_id),
    leadId: coerceNumber(payload.sl_email_lead_id) ?? coerceNumber(payload.lead_id),
    leadMapId: coerceNumber(payload.sl_email_lead_map_id) ?? coerceNumber(payload.lead_map_id),
    leadEmail: firstNonEmpty(lc.targetLeadEmail, payload.sl_lead_email, payload.email, payload.lead_email),
    responderEmail: firstNonEmpty(lc.replyReceivedFrom, payload.from_email, payload.reply_from),
    subject: firstNonEmpty(payload.subject),
    previewText: firstNonEmpty(payload.preview_text, payload.preview),
    eventTimestamp: firstNonEmpty(payload.event_timestamp, payload.time_replied, payload.timestamp),
    statsId: firstNonEmpty(payload.stats_id),
    appUrl: firstNonEmpty(payload.app_url, payload.ui_master_inbox_link),
    secretKey: firstNonEmpty(payload.secret_key),
    payload,
  };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function makeEventKey(ctx: ReplyWebhookContext): string {
  const base =
    ctx.statsId ||
    [ctx.eventType, ctx.campaignId ?? "", ctx.leadId ?? "", ctx.leadEmail ?? "", ctx.eventTimestamp ?? ""].join("|");
  return createHash("sha256").update(base).digest("hex");
}

function pruneExpiredKeys(): void {
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [key, seenAt] of seenWebhookEvents) {
    if (seenAt < cutoff) seenWebhookEvents.delete(key);
  }
}

// ─── Agent prompt ─────────────────────────────────────────────────────────────

function buildPrompt(ctx: ReplyWebhookContext): string {
  const lines: string[] = [
    "A Smartlead EMAIL_REPLY webhook has arrived. Do the following:",
    "",
    '1. Send a notification message starting with exactly "New lead answer" to the configured channel.',
    "   Include: lead email, campaign ID, and a one-line reply preview if available.",
    "2. Fetch the full email conversation history using the smartlead CLI:",
  ];

  if (ctx.campaignId != null && ctx.leadId != null) {
    lines.push(
      `   smartlead campaigns leads message-history ${ctx.campaignId} ${ctx.leadId}`,
    );
  } else if (ctx.leadEmail) {
    lines.push(
      `   # lead_id is missing — resolve it first:`,
      `   smartlead leads get-by-email --email "${ctx.leadEmail}"`,
      `   # then fetch history:`,
      `   smartlead campaigns leads message-history ${ctx.campaignId ?? "<campaign_id>"} <resolved_lead_id>`,
    );
  } else {
    lines.push(
      `   # Both lead_id and email are missing. Try:`,
      `   smartlead campaigns leads list ${ctx.campaignId ?? "<campaign_id>"}`,
    );
  }

  lines.push(
    "3. Summarize the conversation thread (bullets or short paragraph) and append it to your channel message.",
    "",
    "── Webhook context ──────────────────────────────────────────",
  );
  if (ctx.campaignId != null) lines.push(`campaign_id:       ${ctx.campaignId}`);
  if (ctx.leadId != null)     lines.push(`lead_id:           ${ctx.leadId}`);
  if (ctx.leadMapId != null)  lines.push(`lead_map_id:       ${ctx.leadMapId}`);
  if (ctx.leadEmail)          lines.push(`lead_email:        ${ctx.leadEmail}`);
  if (ctx.responderEmail)     lines.push(`responder_email:   ${ctx.responderEmail}`);
  if (ctx.subject)            lines.push(`subject:           ${ctx.subject}`);
  if (ctx.previewText)        lines.push(`preview:           ${ctx.previewText}`);
  if (ctx.eventTimestamp)     lines.push(`timestamp:         ${ctx.eventTimestamp}`);
  if (ctx.appUrl)             lines.push(`smartlead_url:     ${ctx.appUrl}`);

  return lines.join("\n");
}

// ─── openclaw /hooks/agent forward ────────────────────────────────────────────

async function forwardToHookAgent(params: {
  cfg: SmartleadPluginConfig;
  apiConfig: any;
  ctx: ReplyWebhookContext;
  logger: any;
}): Promise<void> {
  const { cfg, apiConfig, ctx, logger } = params;

  const url = resolveHookUrl(cfg, apiConfig);
  const token = resolveHookToken(cfg, apiConfig);

  if (!token) {
    logger.error?.("[smartlead] hooks token not configured — set openclawHookToken, OPENCLAW_HOOKS_TOKEN, or hooks.token in openclaw config");
    return;
  }

  const body: JsonObject = {
    message: buildPrompt(ctx),
    name: "Smartlead",
    wakeMode: "now",
    deliver: true,
  };

  const channel = trimString(cfg.hookChannel);
  const agentId = trimString(cfg.hookAgentId);
  if (channel) body.channel = channel;
  if (agentId) body.agentId = agentId;

  try {
    const signal = AbortSignal.timeout(HOOK_FORWARD_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error?.(`[smartlead] /hooks/agent returned ${res.status}: ${text}`);
    }
  } catch (err) {
    logger.error?.(`[smartlead] /hooks/agent call failed: ${String(err)}`);
  }
}

// ─── Webhook route ────────────────────────────────────────────────────────────

export default function registerSmartleadPlugin(api: any) {
  const cfg = asRecord(api.pluginConfig ?? {}) as SmartleadPluginConfig;
  const webhookPath = resolveWebhookPath(cfg);
  const expectedSecret = resolveWebhookSecret(cfg);

  api.registerHttpRoute({
    path: webhookPath,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const method = (req.method ?? "").toUpperCase();

      // GET → health / discovery probe
      if (method === "GET") {
        sendJson(res, 200, { ok: true, plugin: "smartlead", webhookPath, replyEventTypes: REPLY_EVENT_TYPES });
        return;
      }

      if (method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed", allowed: ["GET", "POST"] });
        return;
      }

      // Read body
      let payload: JsonObject;
      try {
        payload = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: "invalid_body", message: String(err) });
        return;
      }

      const ctx = extractReplyContext(payload);

      // Validate webhook secret (timing-safe comparison)
      if (expectedSecret) {
        const headerToken = (() => {
          const auth = getHeader(req, "authorization");
          if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
          return getHeader(req, "x-smartlead-secret") || getHeader(req, "x-webhook-secret");
        })();
        // Accept Smartlead's native secret_key payload field as fallback
        const provided = headerToken || ctx.secretKey;
        if (!provided) {
          sendJson(res, 401, { error: "missing_webhook_secret" });
          return;
        }
        try {
          const a = Buffer.from(provided);
          const b = Buffer.from(expectedSecret);
          // timingSafeEqual requires same-length buffers
          if (a.length !== b.length || !timingSafeEqual(a, b)) {
            sendJson(res, 401, { error: "invalid_webhook_secret" });
            return;
          }
        } catch {
          sendJson(res, 401, { error: "invalid_webhook_secret" });
          return;
        }
      }

      // Event type filter
      const isReplyEvent =
        (ctx.eventType && REPLY_EVENT_TYPES.includes(ctx.eventType)) ||
        // Fallback heuristic only when event_type is completely absent
        (!ctx.eventType && (!!ctx.leadId || !!ctx.statsId));

      if (!isReplyEvent) {
        sendJson(res, 202, {
          ok: true,
          ignored: true,
          event_type: ctx.eventType || null,
          supported: REPLY_EVENT_TYPES,
        });
        return;
      }

      // In-process deduplication (best-effort, cleared on restart)
      pruneExpiredKeys();
      const eventKey = makeEventKey(ctx);
      if (seenWebhookEvents.has(eventKey)) {
        sendJson(res, 200, { ok: true, duplicate: true });
        return;
      }
      seenWebhookEvents.set(eventKey, Date.now());

      // Respond to Smartlead immediately, then forward async.
      // This prevents Smartlead retries if openclaw is slow or misconfigured.
      sendJson(res, 202, {
        ok: true,
        event_type: ctx.eventType || "EMAIL_REPLY",
        campaign_id: ctx.campaignId ?? null,
        lead_id: ctx.leadId ?? null,
        lead_email: ctx.leadEmail ?? null,
      });

      void forwardToHookAgent({ cfg, apiConfig: api.config, ctx, logger: api.logger });
    },
  });
}
