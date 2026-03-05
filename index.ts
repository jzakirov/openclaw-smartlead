// openclaw-smartlead plugin
// Registers one HTTP route that receives Smartlead webhook events and forwards
// EMAIL_REPLY events to the OpenClaw mapped hook endpoint (/hooks/smartlead by default).
// The plugin stays transport-focused: validate -> parse -> dedupe -> forward.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type JsonObject = Record<string, unknown>;

type SmartleadPluginConfig = {
  webhookSecret?: string;          // validate incoming Smartlead webhooks
  // override-only (auto-derived from api.config by default)
  openclawHookUrl?: string;        // defaults to /hooks/smartlead on local gateway
  openclawHookToken?: string;
  inboundWebhookPath?: string;
};

const DEFAULT_INBOUND_WEBHOOK_PATH = "/smartlead/webhook";
const DEFAULT_OPENCLAW_MAPPED_HOOK_NAME = "smartlead";
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
  return normalizePath(trimString(cfg.inboundWebhookPath) || DEFAULT_INBOUND_WEBHOOK_PATH);
}

function resolveWebhookSecret(cfg: SmartleadPluginConfig): string {
  return trimString(cfg.webhookSecret);
}

// Derives the mapped hook URL from api.config (same gateway process)
// when not explicitly configured. This avoids duplicating port/path.
function resolveHookUrl(cfg: SmartleadPluginConfig, apiConfig: any): string {
  const explicit = trimString(cfg.openclawHookUrl);
  if (explicit) return explicit;
  const port = coerceNumber(apiConfig?.gateway?.port) ?? 18789;
  const hooksPath = trimString(apiConfig?.hooks?.path) || "/hooks";
  return `http://127.0.0.1:${port}${normalizePath(hooksPath)}/${DEFAULT_OPENCLAW_MAPPED_HOOK_NAME}`;
}

// Derives the hook token from api.config when not explicitly configured.
function resolveHookToken(cfg: SmartleadPluginConfig, apiConfig: any): string {
  return trimString(cfg.openclawHookToken) || trimString(apiConfig?.hooks?.token);
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
  campaignName?: string;
  campaignStatus?: string;
  leadId?: number;
  leadMapId?: number;
  leadEmail?: string;
  responderEmail?: string;
  responderName?: string;
  targetName?: string;
  replyCategory?: string;
  repliedCompanyDomain?: string;
  subject?: string;
  previewText?: string;
  eventTimestamp?: string;
  messageId?: string;
  sequenceNumber?: number;
  statsId?: string;
  appUrl?: string;
  secretKey?: string;
  payload: JsonObject;
};

function extractReplyContext(payload: JsonObject): ReplyWebhookContext {
  const lc = asRecord(payload.leadCorrespondence);
  const leadCategory = asRecord(payload.lead_category);
  return {
    eventType: firstNonEmpty(payload.event_type, payload.eventType, payload.type).toUpperCase(),
    campaignId: coerceNumber(payload.campaign_id),
    campaignName: firstNonEmpty(payload.campaign_name),
    campaignStatus: firstNonEmpty(payload.campaign_status),
    leadId: coerceNumber(payload.sl_email_lead_id) ?? coerceNumber(payload.lead_id),
    leadMapId: coerceNumber(payload.sl_email_lead_map_id) ?? coerceNumber(payload.lead_map_id),
    leadEmail: firstNonEmpty(lc.targetLeadEmail, payload.sl_lead_email, payload.email, payload.lead_email),
    responderEmail: firstNonEmpty(lc.replyReceivedFrom, payload.from_email, payload.reply_from),
    responderName: firstNonEmpty(payload.from_name, lc.replyReceivedFromName),
    targetName: firstNonEmpty(payload.to_name, lc.targetLeadName),
    replyCategory: firstNonEmpty(payload.reply_category, payload.category, leadCategory.new_name, leadCategory.name),
    repliedCompanyDomain: firstNonEmpty(lc.repliedCompanyDomain),
    subject: firstNonEmpty(payload.subject),
    previewText: firstNonEmpty(payload.preview_text, payload.preview),
    eventTimestamp: firstNonEmpty(payload.event_timestamp, payload.time_replied, payload.timestamp),
    messageId: firstNonEmpty(payload.message_id),
    sequenceNumber: coerceNumber(payload.sequence_number),
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

// ─── Forward payload shaping ──────────────────────────────────────────────────

function sanitizeForForward(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForForward);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "secret_key" || k === "secretKey") {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = sanitizeForForward(v);
  }
  return out;
}

function buildPayloadSummary(ctx: ReplyWebhookContext): JsonObject {
  const leadCorrespondence = asRecord(ctx.payload.leadCorrespondence);
  return {
    topLevelKeys: Object.keys(ctx.payload).sort(),
    leadCorrespondenceKeys: Object.keys(leadCorrespondence).sort(),
    hasLeadCorrespondence: Object.keys(leadCorrespondence).length > 0,
    hasReplyCategory: Boolean(ctx.replyCategory),
    hasMessageId: Boolean(ctx.messageId),
    hasLeadId: ctx.leadId != null,
    hasLeadEmail: Boolean(ctx.leadEmail),
  };
}

function buildForwardPayload(params: {
  ctx: ReplyWebhookContext;
  eventKey: string;
  webhookPath: string;
}): JsonObject {
  const { ctx, eventKey, webhookPath } = params;
  return {
    source: "smartlead",
    plugin: "smartlead",
    kind: "smartlead.webhook",
    eventType: ctx.eventType || null,
    event_type: ctx.eventType || null,
    webhookPath,
    receivedAt: new Date().toISOString(),
    dedupeKey: eventKey,

    // Flat aliases for easy hook mapping templates
    campaign_id: ctx.campaignId ?? null,
    campaign_name: ctx.campaignName ?? null,
    campaign_status: ctx.campaignStatus ?? null,
    lead_id: ctx.leadId ?? null,
    lead_map_id: ctx.leadMapId ?? null,
    lead_email: ctx.leadEmail ?? null,
    responder_email: ctx.responderEmail ?? null,
    responder_name: ctx.responderName ?? null,
    target_name: ctx.targetName ?? null,
    reply_category: ctx.replyCategory ?? null,
    replied_company_domain: ctx.repliedCompanyDomain ?? null,
    subject: ctx.subject ?? null,
    preview_text: ctx.previewText ?? null,
    event_timestamp: ctx.eventTimestamp ?? null,
    message_id: ctx.messageId ?? null,
    sequence_number: ctx.sequenceNumber ?? null,
    stats_id: ctx.statsId ?? null,
    app_url: ctx.appUrl ?? null,

    context: {
      campaignId: ctx.campaignId ?? null,
      campaignName: ctx.campaignName ?? null,
      campaignStatus: ctx.campaignStatus ?? null,
      leadId: ctx.leadId ?? null,
      leadMapId: ctx.leadMapId ?? null,
      leadEmail: ctx.leadEmail ?? null,
      responderEmail: ctx.responderEmail ?? null,
      responderName: ctx.responderName ?? null,
      targetName: ctx.targetName ?? null,
      replyCategory: ctx.replyCategory ?? null,
      repliedCompanyDomain: ctx.repliedCompanyDomain ?? null,
      subject: ctx.subject ?? null,
      previewText: ctx.previewText ?? null,
      eventTimestamp: ctx.eventTimestamp ?? null,
      messageId: ctx.messageId ?? null,
      sequenceNumber: ctx.sequenceNumber ?? null,
      statsId: ctx.statsId ?? null,
      appUrl: ctx.appUrl ?? null,
    },

    payloadSummary: buildPayloadSummary(ctx),
    payload: sanitizeForForward(ctx.payload),
  };
}

// ─── openclaw mapped hook forward ─────────────────────────────────────────────

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

  try {
    const signal = AbortSignal.timeout(HOOK_FORWARD_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(ctx.payload),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error?.(`[smartlead] mapped hook returned ${res.status} from ${url}: ${text}`);
    }
  } catch (err) {
    logger.error?.(`[smartlead] mapped hook call failed (${url}): ${String(err)}`);
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
        sendJson(res, 200, {
          ok: true,
          plugin: "smartlead",
          mode: "mapped-hook-forwarder",
          webhookPath,
          forwardsToHookPath: `/hooks/${DEFAULT_OPENCLAW_MAPPED_HOOK_NAME}`,
          replyEventTypes: REPLY_EVENT_TYPES,
        });
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

      const forwardPayload = buildForwardPayload({ ctx, eventKey, webhookPath });

      // Respond to Smartlead immediately, then forward async.
      // This prevents Smartlead retries if openclaw is slow or misconfigured.
      sendJson(res, 202, {
        ok: true,
        event_type: ctx.eventType || "EMAIL_REPLY",
        campaign_id: ctx.campaignId ?? null,
        lead_id: ctx.leadId ?? null,
        lead_email: ctx.leadEmail ?? null,
      });

      void forwardToHookAgent({
        cfg,
        apiConfig: api.config,
        ctx: { ...ctx, payload: forwardPayload },
        logger: api.logger,
      });
    },
  });
}
