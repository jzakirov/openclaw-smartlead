import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type JsonObject = Record<string, unknown>;

type SmartleadPluginConfig = {
  apiBaseUrl?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  inboundWebhookPath?: string;
  webhookSecret?: string;
  replyEventTypes?: string[];
  openclawAgentHookUrl?: string;
  openclawHookToken?: string;
  hookName?: string;
  hookAgentId?: string;
  hookSessionKeyPrefix?: string;
  hookWakeMode?: "now" | "next-heartbeat";
  hookDeliver?: boolean;
  hookChannel?: string;
  hookTo?: string;
  hookModel?: string;
  hookThinking?: string;
  hookTimeoutSeconds?: number;
  dedupeTtlSeconds?: number;
  logWebhookPayload?: boolean;
};

const DEFAULT_SMARTLEAD_BASE_URL = "https://server.smartlead.ai/api/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INBOUND_WEBHOOK_PATH = "/smartlead/webhook";
const DEFAULT_REPLY_EVENT_TYPES = ["EMAIL_REPLY"];
const DEFAULT_HOOK_WAKE_MODE = "now";
const DEFAULT_HOOK_NAME = "Smartlead";
const DEFAULT_SESSION_KEY_PREFIX = "hook:smartlead:reply:";
const DEFAULT_DEDUPE_TTL_SECONDS = 15 * 60;
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

const seenWebhookEvents = new Map<string, number>();

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const v = trimString(value);
    if (v) return v;
  }
  return "";
}

function getNested(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as JsonObject)[key];
  }
  return cur;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_SMARTLEAD_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeReplyEventTypes(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : undefined;
  const values = (arr ?? DEFAULT_REPLY_EVENT_TYPES)
    .map((v) => trimString(v).toUpperCase())
    .filter(Boolean);
  return values.length > 0 ? Array.from(new Set(values)) : [...DEFAULT_REPLY_EVENT_TYPES];
}

function pickPluginConfig(api: any): SmartleadPluginConfig {
  return asRecord(api.pluginConfig ?? {}) as SmartleadPluginConfig;
}

function getSmartleadApiKey(cfg: SmartleadPluginConfig): string {
  return trimString(cfg.apiKey) || trimString(process.env.SMARTLEAD_API_KEY);
}

function getSmartleadBaseUrl(cfg: SmartleadPluginConfig): string {
  return normalizeBaseUrl(
    trimString(cfg.apiBaseUrl) || trimString(process.env.SMARTLEAD_API_BASE_URL) || DEFAULT_SMARTLEAD_BASE_URL,
  );
}

function getRequestTimeoutMs(cfg: SmartleadPluginConfig): number {
  const n =
    coerceNumber(cfg.requestTimeoutMs) ??
    coerceNumber(process.env.SMARTLEAD_REQUEST_TIMEOUT_MS) ??
    DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(1_000, Math.min(120_000, n));
}

function getInboundWebhookPath(cfg: SmartleadPluginConfig): string {
  return normalizePath(
    trimString(cfg.inboundWebhookPath) ||
      trimString(process.env.SMARTLEAD_WEBHOOK_PATH) ||
      DEFAULT_INBOUND_WEBHOOK_PATH,
  );
}

function getWebhookSecret(cfg: SmartleadPluginConfig): string {
  return trimString(cfg.webhookSecret) || trimString(process.env.SMARTLEAD_WEBHOOK_SECRET);
}

function getOpenClawHookUrl(cfg: SmartleadPluginConfig): string {
  return trimString(cfg.openclawAgentHookUrl) || trimString(process.env.OPENCLAW_SMARTLEAD_AGENT_HOOK_URL);
}

function getOpenClawHookToken(cfg: SmartleadPluginConfig): string {
  return trimString(cfg.openclawHookToken) || trimString(process.env.OPENCLAW_HOOKS_TOKEN);
}

function getDedupeTtlSeconds(cfg: SmartleadPluginConfig): number {
  const n =
    coerceNumber(cfg.dedupeTtlSeconds) ??
    coerceNumber(process.env.SMARTLEAD_DEDUPE_TTL_SECONDS) ??
    DEFAULT_DEDUPE_TTL_SECONDS;
  return Math.max(1, Math.min(86400, Math.floor(n)));
}

function appendQuery(url: URL, query?: unknown) {
  const obj = asRecord(query);
  for (const [key, raw] of Object.entries(obj)) {
    if (raw == null) continue;
    if (Array.isArray(raw)) {
      for (const item of raw) url.searchParams.append(key, String(item));
      continue;
    }
    url.searchParams.set(key, String(raw));
  }
}

async function smartleadRequest(params: {
  cfg: SmartleadPluginConfig;
  method: string;
  path: string;
  query?: unknown;
  body?: unknown;
  signal?: AbortSignal;
}) {
  const apiKey = getSmartleadApiKey(params.cfg);
  if (!apiKey) {
    throw new Error("Smartlead API key is required (plugin config apiKey or SMARTLEAD_API_KEY)");
  }

  const baseUrl = getSmartleadBaseUrl(params.cfg);
  const path = normalizePath(params.path);
  const relativePath = path.replace(/^\/+/, "");
  const url = new URL(relativePath, `${baseUrl}/`);
  url.searchParams.set("api_key", apiKey);
  appendQuery(url, params.query);

  const timeoutMs = getRequestTimeoutMs(params.cfg);
  const signal = params.signal ?? AbortSignal.timeout(timeoutMs);
  const res = await fetch(url.toString(), {
    method: params.method.toUpperCase(),
    headers: {
      "Content-Type": "application/json",
    },
    body:
      params.body === undefined || params.method.toUpperCase() === "GET"
        ? undefined
        : JSON.stringify(params.body),
    signal,
  });

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  let parsed: unknown;
  if (contentType.includes("application/json")) {
    try {
      parsed = await res.json();
    } catch {
      parsed = { text: await res.text() };
    }
  } else {
    const text = await res.text();
    parsed = text ? { text } : { ok: res.ok };
  }

  if (!res.ok) {
    throw new Error(
      `Smartlead HTTP ${res.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`,
    );
  }

  return {
    status: res.status,
    url: url.toString(),
    data: parsed,
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_WEBHOOK_BODY_BYTES) {
      throw new Error(`Payload too large (${size} bytes)`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  const raw = await readRequestBody(req);
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  return asRecord(parsed);
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function getHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value : "";
}

function extractRequestToken(req: IncomingMessage): string {
  const host = getHeader(req, "host") || "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const auth = getHeader(req, "authorization");
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return (
    trimString(url.searchParams.get("token")) ||
    trimString(url.searchParams.get("secret")) ||
    trimString(getHeader(req, "x-smartlead-secret")) ||
    trimString(getHeader(req, "x-webhook-secret"))
  );
}

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
  messageId?: string;
  appUrl?: string;
  description?: string;
  secretKey?: string;
  leadCorrespondence?: JsonObject;
  payload: JsonObject;
};

function extractReplyWebhookContext(payload: JsonObject): ReplyWebhookContext {
  const leadCorrespondence = asRecord(payload.leadCorrespondence);
  return {
    eventType: firstNonEmptyString(payload.event_type, payload.eventType, payload.type).toUpperCase(),
    campaignId: coerceNumber(payload.campaign_id),
    leadId: coerceNumber(payload.sl_email_lead_id) ?? coerceNumber(payload.lead_id),
    leadMapId: coerceNumber(payload.sl_email_lead_map_id) ?? coerceNumber(payload.lead_map_id),
    leadEmail: firstNonEmptyString(
      leadCorrespondence.targetLeadEmail,
      payload.sl_lead_email,
      payload.email,
      payload.lead_email,
    ),
    responderEmail: firstNonEmptyString(
      leadCorrespondence.replyReceivedFrom,
      payload.from_email,
      payload.reply_from,
      payload.to_email,
    ),
    subject: firstNonEmptyString(payload.subject),
    previewText: firstNonEmptyString(payload.preview_text, payload.preview, payload.snippet),
    eventTimestamp: firstNonEmptyString(payload.event_timestamp, payload.time_replied, payload.timestamp),
    statsId: firstNonEmptyString(payload.stats_id),
    messageId: firstNonEmptyString(payload.message_id),
    appUrl: firstNonEmptyString(payload.app_url, payload.ui_master_inbox_link),
    description: firstNonEmptyString(payload.description),
    secretKey: firstNonEmptyString(payload.secret_key),
    leadCorrespondence: Object.keys(leadCorrespondence).length > 0 ? leadCorrespondence : undefined,
    payload,
  };
}

function makeWebhookEventKey(ctx: ReplyWebhookContext): string {
  const base =
    ctx.statsId ||
    ctx.messageId ||
    [
      ctx.eventType,
      ctx.campaignId ?? "",
      ctx.leadId ?? "",
      ctx.leadEmail ?? "",
      ctx.eventTimestamp ?? "",
    ].join("|");
  return createHash("sha256").update(base).digest("hex");
}

function pruneSeenWebhookEvents(ttlSeconds: number) {
  const cutoff = Date.now() - ttlSeconds * 1000;
  for (const [key, seenAt] of seenWebhookEvents) {
    if (seenAt < cutoff) seenWebhookEvents.delete(key);
  }
}

function sanitizeSessionKeyPart(input: string): string {
  return input.replace(/[^a-zA-Z0-9:_-]+/g, "-").slice(0, 80);
}

function buildHookSessionKey(cfg: SmartleadPluginConfig, ctx: ReplyWebhookContext): string {
  const prefix = trimString(cfg.hookSessionKeyPrefix) || DEFAULT_SESSION_KEY_PREFIX;
  const sourcePart = sanitizeSessionKeyPart(ctx.statsId || ctx.messageId || makeWebhookEventKey(ctx).slice(0, 16));
  return `${prefix}${sourcePart}`;
}

function buildSmartleadReplyPrompt(ctx: ReplyWebhookContext): string {
  const lines: string[] = [];
  lines.push(
    "Smartlead EMAIL_REPLY webhook received. Send a short user-facing alert to the configured channel.",
  );
  lines.push('Start the message with exactly: "New lead answer"');
  lines.push(
    "Then summarize the prior conversation with this lead (concise bullets or short paragraph).",
  );
  lines.push(
    "If campaign_id and lead_id are available, call smartlead_get_campaign_lead_message_history first.",
  );
  lines.push(
    "If lead_id is missing but email is available, call smartlead_get_lead_by_email to resolve the lead, then continue.",
  );
  lines.push("Prefer leadCorrespondence.targetLeadEmail as the original target lead.");
  lines.push("");
  lines.push("Resolved fields:");
  if (ctx.campaignId != null) lines.push(`- campaign_id: ${ctx.campaignId}`);
  if (ctx.leadId != null) lines.push(`- lead_id: ${ctx.leadId}`);
  if (ctx.leadMapId != null) lines.push(`- lead_map_id: ${ctx.leadMapId}`);
  if (ctx.leadEmail) lines.push(`- lead_email: ${ctx.leadEmail}`);
  if (ctx.responderEmail) lines.push(`- responder_email: ${ctx.responderEmail}`);
  if (ctx.subject) lines.push(`- subject: ${ctx.subject}`);
  if (ctx.previewText) lines.push(`- preview_text: ${ctx.previewText}`);
  if (ctx.appUrl) lines.push(`- smartlead_app_url: ${ctx.appUrl}`);
  if (ctx.eventTimestamp) lines.push(`- event_timestamp: ${ctx.eventTimestamp}`);
  lines.push("");
  lines.push("Webhook payload JSON:");
  lines.push("```json");
  lines.push(JSON.stringify(ctx.payload, null, 2));
  lines.push("```");
  return lines.join("\n");
}

async function forwardToOpenClawAgentHook(params: {
  cfg: SmartleadPluginConfig;
  replyCtx: ReplyWebhookContext;
  signal?: AbortSignal;
}) {
  const { cfg, replyCtx } = params;
  const url = getOpenClawHookUrl(cfg);
  const token = getOpenClawHookToken(cfg);
  if (!url) {
    throw new Error("openclawAgentHookUrl is required for webhook forwarding");
  }
  if (!token) {
    throw new Error("openclawHookToken (or OPENCLAW_HOOKS_TOKEN) is required for webhook forwarding");
  }

  const body: JsonObject = {
    message: buildSmartleadReplyPrompt(replyCtx),
    name: trimString(cfg.hookName) || DEFAULT_HOOK_NAME,
    sessionKey: buildHookSessionKey(cfg, replyCtx),
    wakeMode: trimString(cfg.hookWakeMode) || DEFAULT_HOOK_WAKE_MODE,
    deliver: cfg.hookDeliver ?? true,
  };

  const agentId = trimString(cfg.hookAgentId);
  const channel = trimString(cfg.hookChannel);
  const to = trimString(cfg.hookTo);
  const model = trimString(cfg.hookModel);
  const thinking = trimString(cfg.hookThinking);
  const timeoutSeconds = coerceNumber(cfg.hookTimeoutSeconds);

  if (agentId) body.agentId = agentId;
  if (channel) body.channel = channel;
  if (to) body.to = to;
  if (model) body.model = model;
  if (thinking) body.thinking = thinking;
  if (timeoutSeconds && timeoutSeconds > 0) body.timeoutSeconds = Math.floor(timeoutSeconds);

  const timeoutMs = getRequestTimeoutMs(cfg);
  const signal = params.signal ?? AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const responseData = contentType.includes("application/json") ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    throw new Error(`OpenClaw hook HTTP ${res.status}: ${JSON.stringify(responseData)}`);
  }

  return { status: res.status, data: responseData, request: body };
}

function registerSmartleadTools(api: any, cfg: SmartleadPluginConfig) {
  api.registerTool({
    name: "smartlead_list_campaigns",
    description: "List Smartlead campaigns. Use before choosing a campaign_id for lead/webhook operations.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "object",
          description: "Optional query params (e.g. client_id, offset, limit).",
          additionalProperties: true,
        },
      },
      required: [],
    },
    async execute(_id: string, params: any, signal: AbortSignal) {
      const result = await smartleadRequest({
        cfg,
        method: "GET",
        path: "/campaigns",
        query: params?.query,
        signal,
      });
      return jsonResult(result);
    },
  });

  api.registerTool({
    name: "smartlead_get_lead_by_email",
    description:
      "Look up a Smartlead lead globally by email. Useful when a webhook has an email address but you still need IDs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: { type: "string" },
      },
      required: ["email"],
    },
    async execute(_id: string, params: any, signal: AbortSignal) {
      const email = trimString(params?.email);
      if (!email) throw new Error("email is required");
      const result = await smartleadRequest({
        cfg,
        method: "GET",
        path: "/leads",
        query: { email },
        signal,
      });
      return jsonResult(result);
    },
  });

  api.registerTool({
    name: "smartlead_get_campaign_lead_message_history",
    description:
      "Fetch prior email conversation/message history for a lead in a Smartlead campaign. Use this to summarize prior exchanges.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        campaign_id: { type: "number" },
        lead_id: { type: "number" },
      },
      required: ["campaign_id", "lead_id"],
    },
    async execute(_id: string, params: any, signal: AbortSignal) {
      const campaignId = coerceNumber(params?.campaign_id);
      const leadId = coerceNumber(params?.lead_id);
      if (campaignId == null || leadId == null) throw new Error("campaign_id and lead_id are required");
      const result = await smartleadRequest({
        cfg,
        method: "GET",
        path: `/campaigns/${campaignId}/leads/${leadId}/message-history`,
        signal,
      });
      return jsonResult(result);
    },
  });

  api.registerTool({
    name: "smartlead_list_campaign_webhooks",
    description: "List Smartlead webhooks configured for a campaign.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        campaign_id: { type: "number" },
      },
      required: ["campaign_id"],
    },
    async execute(_id: string, params: any, signal: AbortSignal) {
      const campaignId = coerceNumber(params?.campaign_id);
      if (campaignId == null) throw new Error("campaign_id is required");
      const result = await smartleadRequest({
        cfg,
        method: "GET",
        path: `/campaigns/${campaignId}/webhooks`,
        signal,
      });
      return jsonResult(result);
    },
  });

  api.registerTool({
    name: "smartlead_upsert_campaign_webhook",
    description:
      "Add or update a Smartlead campaign webhook. Request body usually includes id (or null), name, webhook_url, event_types, categories.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        campaign_id: { type: "number" },
        body: {
          type: "object",
          additionalProperties: true,
        },
      },
      required: ["campaign_id", "body"],
    },
    async execute(_id: string, params: any, signal: AbortSignal) {
      const campaignId = coerceNumber(params?.campaign_id);
      if (campaignId == null) throw new Error("campaign_id is required");
      const body = asRecord(params?.body);
      const result = await smartleadRequest({
        cfg,
        method: "POST",
        path: `/campaigns/${campaignId}/webhooks`,
        body,
        signal,
      });
      return jsonResult(result);
    },
  });

  api.registerTool({
    name: "smartlead_delete_campaign_webhook",
    description: "Delete a Smartlead campaign webhook using webhook_id query param.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        campaign_id: { type: "number" },
        webhook_id: { type: "number" },
      },
      required: ["campaign_id", "webhook_id"],
    },
    async execute(_id: string, params: any, signal: AbortSignal) {
      const campaignId = coerceNumber(params?.campaign_id);
      const webhookId = coerceNumber(params?.webhook_id);
      if (campaignId == null || webhookId == null) throw new Error("campaign_id and webhook_id are required");
      const result = await smartleadRequest({
        cfg,
        method: "DELETE",
        path: `/campaigns/${campaignId}/webhooks`,
        query: { webhook_id: webhookId },
        signal,
      });
      return jsonResult(result);
    },
  });

  api.registerTool({
    name: "smartlead_raw_request",
    description:
      "Raw Smartlead API request fallback. Use for endpoints not covered by specific tools. Path is relative to /api/v1.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        method: { type: "string" },
        path: { type: "string" },
        query: { type: "object", additionalProperties: true },
        body: {
          description: "Optional JSON request body",
          anyOf: [
            { type: "object", additionalProperties: true },
            { type: "array" },
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "null" },
          ],
        },
      },
      required: ["method", "path"],
    },
    async execute(_id: string, params: any, signal: AbortSignal) {
      const method = trimString(params?.method || "GET").toUpperCase();
      const path = trimString(params?.path);
      if (!path) throw new Error("path is required");
      const result = await smartleadRequest({
        cfg,
        method,
        path,
        query: params?.query,
        body: params?.body,
        signal,
      });
      return jsonResult(result);
    },
  });
}

function registerSmartleadWebhookRoute(api: any, cfg: SmartleadPluginConfig) {
  const path = getInboundWebhookPath(cfg);
  const replyEventTypes = normalizeReplyEventTypes(cfg.replyEventTypes);
  const logRawPayload = cfg.logWebhookPayload === true;

  api.registerHttpRoute({
    path,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if ((req.method ?? "").toUpperCase() === "GET") {
        sendJson(res, 200, {
          ok: true,
          plugin: "smartlead",
          webhookPath: path,
          note: "POST Smartlead webhook payloads here.",
        });
        return;
      }

      if ((req.method ?? "").toUpperCase() !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed", allowed: ["GET", "POST"] });
        return;
      }

      let payload: JsonObject;
      try {
        payload = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: "invalid_json", message: String(err) });
        return;
      }

      const ctx = extractReplyWebhookContext(payload);
      const expectedSecret = getWebhookSecret(cfg);
      const providedToken = extractRequestToken(req);
      const providedSecret = firstNonEmptyString(providedToken, ctx.secretKey);
      if (expectedSecret && providedSecret !== expectedSecret) {
        sendJson(res, 401, { error: "invalid_webhook_secret" });
        return;
      }

      if (logRawPayload) {
        api.logger.info?.(`[smartlead] webhook payload: ${JSON.stringify(payload)}`);
      }

      const isReplyEvent =
        (ctx.eventType && replyEventTypes.includes(ctx.eventType)) ||
        (!ctx.eventType && Boolean(ctx.previewText || ctx.leadCorrespondence || payload.time_replied));

      if (!isReplyEvent) {
        sendJson(res, 202, {
          ok: true,
          ignored: true,
          reason: "unsupported_event_type",
          event_type: ctx.eventType || null,
          supported_event_types: replyEventTypes,
        });
        return;
      }

      const dedupeTtlSeconds = getDedupeTtlSeconds(cfg);
      pruneSeenWebhookEvents(dedupeTtlSeconds);
      const dedupeKey = makeWebhookEventKey(ctx);
      if (seenWebhookEvents.has(dedupeKey)) {
        sendJson(res, 200, { ok: true, duplicate: true, event_key: dedupeKey });
        return;
      }
      seenWebhookEvents.set(dedupeKey, Date.now());

      try {
        const forwarded = await forwardToOpenClawAgentHook({ cfg, replyCtx: ctx });
        sendJson(res, 202, {
          ok: true,
          forwarded: true,
          event_type: ctx.eventType || "EMAIL_REPLY",
          campaign_id: ctx.campaignId ?? null,
          lead_id: ctx.leadId ?? null,
          lead_email: ctx.leadEmail ?? null,
          openclaw_status: forwarded.status,
        });
      } catch (err) {
        api.logger.error?.(`[smartlead] webhook forward failed: ${String(err)}`);
        sendJson(res, 500, { error: "hook_forward_failed", message: String(err) });
      }
    },
  });
}

export default function registerSmartleadPlugin(api: any) {
  const cfg = pickPluginConfig(api);
  registerSmartleadTools(api, cfg);
  registerSmartleadWebhookRoute(api, cfg);
}
