import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { verifyWebhook } from "./lib/polarSignature";
import { otlpIngestHandler } from "./otlpIngest";
import { nativeIngestHandler } from "./nativeIngest";

const http = httpRouter();

auth.addHttpRoutes(http);

// --- Polar billing webhook ---

/**
 * Pull ONLY the scalar billing fields we need out of a Polar event. Never
 * forwards arbitrary payload (no trace/test-case content can leak this way).
 * `orgId`/`packageKey` come from the metadata we set at checkout, falling back
 * to the customer's external id (which is the org id).
 */
function sanitizePolarEvent(eventId: string, event: unknown) {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const eventType = typeof e.type === "string" ? e.type : "";
  if (!eventType) return null;
  const data = (e.data ?? {}) as Record<string, unknown>;
  const meta = (data.metadata ?? {}) as Record<string, unknown>;
  const customer = (data.customer ?? {}) as Record<string, unknown>;
  const subscription = (data.subscription ?? {}) as Record<string, unknown>;

  const str = (x: unknown): string | undefined =>
    typeof x === "string" && x.length > 0 ? x : undefined;

  const externalCustomerId =
    str(meta.orgId) ??
    str(data.external_customer_id) ??
    str(customer.external_id) ??
    str(data.customer_external_id);
  if (!externalCustomerId) return null;

  return {
    eventId,
    eventType,
    externalCustomerId,
    packageKey: str(meta.packageKey),
    polarCustomerId: str(data.customer_id) ?? str(customer.id),
    polarOrderId:
      eventType.startsWith("order") ? str(data.id) ?? str(data.order_id) : str(data.order_id),
    polarSubscriptionId:
      str(data.subscription_id) ?? str(subscription.id) ??
      (eventType.startsWith("subscription") ? str(data.id) : undefined),
  };
}

http.route({
  path: "/polar/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.POLAR_WEBHOOK_SECRET;
    if (!secret) {
      return new Response("Billing webhook not configured", { status: 503 });
    }

    const id = req.headers.get("webhook-id");
    const timestamp = req.headers.get("webhook-timestamp");
    const signature = req.headers.get("webhook-signature");
    const body = await req.text();

    if (!id || !timestamp || !signature) {
      return new Response("Missing signature headers", { status: 400 });
    }

    const ok = await verifyWebhook({ id, timestamp, signature, body, secret });
    if (!ok) {
      return new Response("Invalid signature", { status: 401 });
    }

    let event: unknown;
    try {
      event = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const sanitized = sanitizePolarEvent(id, event);
    if (!sanitized) {
      // Acknowledge so Polar doesn't retry an event we can't route.
      return new Response(JSON.stringify({ ok: true, ignored: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runMutation(
      internal.billing.applyPolarEvent,
      sanitized,
    );
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// --- Landing page demo vote endpoints ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

http.route({
  path: "/api/demo-vote",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.json();
    const choice = body.choice;
    if (choice !== "A" && choice !== "B") {
      return new Response(JSON.stringify({ error: "Invalid choice" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    await ctx.runMutation(internal.demoVotes.castVote, { choice });
    const stats = await ctx.runQuery(internal.demoVotes.getStats);
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: corsHeaders,
    });
  }),
});

http.route({
  path: "/api/demo-stats",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const stats = await ctx.runQuery(internal.demoVotes.getStats);
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: corsHeaders,
    });
  }),
});

http.route({
  path: "/api/demo-vote",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: corsHeaders });
  }),
});

http.route({
  path: "/api/demo-stats",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: corsHeaders });
  }),
});

// --- #263: OTLP Gen-AI trace ingest (per-project token auth) ---
http.route({
  path: "/otlp/v1/traces",
  method: "POST",
  handler: otlpIngestHandler,
});
http.route({
  path: "/otlp/v1/traces",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-blindbench-ingest-token",
      },
    });
  }),
});

// --- Native `eval-record` v1 JSON trace ingest (per-project token auth) ---
http.route({
  path: "/ingest/v1/traces",
  method: "POST",
  handler: nativeIngestHandler,
});
http.route({
  path: "/ingest/v1/traces",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-blindbench-ingest-token",
      },
    });
  }),
});

export default http;
