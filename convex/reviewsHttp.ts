/** Public HTTP boundary for customer-managed verdict review automation. */
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { json, readToken } from "./otlpIngest";

const MAX_BODY_BYTES = 256 * 1024;
const CREATE_KEYS = new Set(["name", "instructions", "trace_ids", "idempotency_key"]);
const CLOSE_KEYS = new Set(["review_id"]);

type CreateInput = {
  readonly name: string;
  readonly instructions?: string;
  readonly traceIds: ReadonlyArray<string>;
  readonly idempotencyKey: string;
};

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: 400 | 413; readonly error: string };

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function readJsonObject(req: Request): Promise<ParseResult<Record<string, unknown>>> {
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "Payload too large" };
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "Payload too large" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" };
  }
  const record = objectRecord(decoded);
  if (!record) return { ok: false, status: 400, error: "JSON body must be an object" };
  return { ok: true, value: record };
}

function parseCreate(record: Record<string, unknown>): ParseResult<CreateInput> {
  if (Object.keys(record).some((key) => !CREATE_KEYS.has(key))) {
    return { ok: false, status: 400, error: "Request contains an unknown field" };
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || name.length > 120) return { ok: false, status: 400, error: "name must be 1 to 120 characters" };
  const idempotencyKey = typeof record.idempotency_key === "string" ? record.idempotency_key.trim() : "";
  if (!idempotencyKey || idempotencyKey.length > 200) return { ok: false, status: 400, error: "idempotency_key must be 1 to 200 characters" };
  const instructions = record.instructions === undefined ? undefined : typeof record.instructions === "string" ? record.instructions.trim() : null;
  if (instructions === null || (instructions !== undefined && instructions.length > 2_000)) {
    return { ok: false, status: 400, error: "instructions must be at most 2000 characters" };
  }
  if (!Array.isArray(record.trace_ids)) return { ok: false, status: 400, error: "trace_ids must be an array" };
  if (record.trace_ids.length > 50) return { ok: false, status: 413, error: "trace_ids supports at most 50 runs" };
  if (record.trace_ids.length === 0 || record.trace_ids.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    return { ok: false, status: 400, error: "trace_ids must contain 1 to 50 non-empty strings" };
  }
  const traceIds = record.trace_ids.map((value) => String(value).trim());
  if (new Set(traceIds).size !== traceIds.length) return { ok: false, status: 400, error: "trace_ids must not contain duplicates" };
  return {
    ok: true,
    value: {
      name,
      ...(instructions ? { instructions } : {}),
      traceIds,
      idempotencyKey,
    },
  };
}

async function fingerprint(input: CreateInput): Promise<string> {
  const canonical = JSON.stringify({
    name: input.name,
    instructions: input.instructions ?? null,
    trace_ids: input.traceIds,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function siteUrl(): string {
  const configured = process.env.SITE_URL?.trim();
  return (configured || "https://blindbench.dev").replace(/\/+$/, "");
}

function authToken(req: Request): string | null {
  return readToken(req) ?? null;
}

/** POST /api/v1/reviews. */
export const createReviewHandler = httpAction(async (ctx, req) => {
  const token = authToken(req);
  if (!token) return json({ error: "Missing API token" }, 401);
  const decoded = await readJsonObject(req);
  if (!decoded.ok) return json({ error: decoded.error }, decoded.status);
  const parsed = parseCreate(decoded.value);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const input = parsed.value;
  const result = await ctx.runMutation(internal.reviewsApi.createReview, {
    token,
    name: input.name,
    instructions: input.instructions,
    traceIds: [...input.traceIds],
    idempotencyKey: input.idempotencyKey,
    fingerprint: await fingerprint(input),
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({
    review_id: result.reviewId,
    status: result.status,
    item_count: result.itemCount,
    review_url: `${siteUrl()}/review/verdict/${result.shareToken}`,
  }, 200);
});

/** GET /api/v1/reviews?id=<review_id>. */
export const getReviewHandler = httpAction(async (ctx, req) => {
  const token = authToken(req);
  if (!token) return json({ error: "Missing API token" }, 401);
  const reviewId = new URL(req.url).searchParams.get("id")?.trim();
  if (!reviewId) return json({ error: "Missing review id" }, 400);
  const result = await ctx.runMutation(internal.reviewsApi.getReview, { token, reviewId });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json(result.summary, 200);
});

/** POST /api/v1/reviews/close. */
export const closeReviewHandler = httpAction(async (ctx, req) => {
  const token = authToken(req);
  if (!token) return json({ error: "Missing API token" }, 401);
  const decoded = await readJsonObject(req);
  if (!decoded.ok) return json({ error: decoded.error }, decoded.status);
  if (Object.keys(decoded.value).some((key) => !CLOSE_KEYS.has(key))) return json({ error: "Request contains an unknown field" }, 400);
  const reviewId = typeof decoded.value.review_id === "string" ? decoded.value.review_id.trim() : "";
  if (!reviewId) return json({ error: "review_id must be a non-empty string" }, 400);
  const result = await ctx.runMutation(internal.reviewsApi.closeReview, { token, reviewId });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json(result.summary, 200);
});
