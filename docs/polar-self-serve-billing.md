# Polar self-serve billing

Foundation for self-serve packages on Blind Bench, paid through
[Polar](https://polar.sh). Owner-scoped, per-organization (workspace)
entitlements — not per-user credits.

## Billing model

- **Packages** — a monthly subscription that grants a fixed bundle: eval
  credits, reviewer seats, trace-import headroom, and a support level. The
  catalog lives in `convex/lib/billingPlans.ts` (`BILLING_PACKAGES`), not in UI
  copy. Stable package keys: `starter`, `team`, `scale`, `enterprise`.
- **Credits** — a fungible per-eval unit tracked in the append-only
  `billingLedger`. **Remaining credits = sum of `creditDelta` for the org.** A
  package purchase adds a positive entry; a refund/revoke adds a negative one.
- **Trial** — every workspace starts with a small free grant (`TRIAL` in
  `billingPlans.ts`): 50 eval credits, 2 reviewer seats, 10 trace imports. No
  card required. (Trial credits are represented in config; seed them into the
  ledger when you wire trial provisioning — the foundation does not auto-seed.)
- **Manual enterprise** — the `enterprise` package has `manualEnterprise: true`:
  no self-serve product, the checkout button is replaced by "Contact sales".
  Provision it by inserting an `active` `billingEntitlements` row + a ledger
  grant by hand (or a small admin mutation) after the contract is signed.
- **Refund rules** — a `order.refunded` webhook reverses the *exact* credits
  granted for that order (one reversal per order, idempotent) and flips the
  active entitlement to `revoked`. A `subscription.revoked`/`canceled` event
  revokes the entitlement but leaves already-granted credits intact (the
  customer keeps what they paid for through the period).

## Data boundary (payment state vs. trace data)

Payment state lives **only** in four tables: `billingCustomers`,
`billingEntitlements`, `billingLedger`, `polarWebhookEvents`. None of them
reference or store trace / test-case / eval content. The webhook handler
(`convex/http.ts`) extracts **only** scalar billing fields (event id/type,
external customer id, package key, Polar order/subscription/customer ids) via
`sanitizePolarEvent` before anything is persisted — the raw payload is never
logged or stored, so no customer trace data can leak through billing events.
Metadata we send to Polar at checkout is limited to `orgId`, `packageKey`, and
`environment`.

## Configuration (Convex dashboard env vars)

| Var | Purpose |
|-----|---------|
| `POLAR_ACCESS_TOKEN` | Polar organization access token (server-side only). |
| `POLAR_WEBHOOK_SECRET` | Standard Webhooks secret (`whsec_…`) for signature verification. |
| `POLAR_PRODUCT_STARTER` | Polar product id for the Starter package. |
| `POLAR_PRODUCT_TEAM` | Polar product id for the Team package. |
| `POLAR_PRODUCT_SCALE` | Polar product id for the Scale package. |
| `POLAR_PRODUCT_ENTERPRISE` | Optional; enterprise is manual. |
| `POLAR_API_URL` | Override base URL. Default `https://api.polar.sh`; use `https://sandbox-api.polar.sh` for sandbox. |
| `POLAR_ENV` | Free-form tag echoed into checkout metadata (`sandbox`/`production`). |
| `APP_BASE_URL` | App origin for the checkout `success_url`. Default `http://localhost:5173`. |

Checkout and portal **fail closed** with a `ConvexError` when the token or a
product id is missing — nothing half-works.

## Webhook setup

1. In Polar, add a webhook endpoint pointing at
   `https://<your-convex-deployment>.convex.site/polar/webhook`.
2. Select the Standard Webhooks format. Subscribe to at least: `order.paid`,
   `order.refunded`, `subscription.revoked`, `subscription.canceled`.
3. Copy the signing secret into `POLAR_WEBHOOK_SECRET`.

The handler verifies `webhook-id` / `webhook-timestamp` / `webhook-signature`
(HMAC-SHA256, 5-minute replay window) and is **idempotent**: by `webhook-id`
(re-delivery is a no-op) and by Polar order id (a duplicate order never
double-credits).

## Local testing

- Unit tests, no live Polar:
  - `env -u NODE_ENV npx vitest run --config convex/vitest.config.ts convex/lib/__tests__/polarSignature.test.ts` — signature sign/verify/replay.
  - `env -u NODE_ENV npm run test:convex` — webhook idempotency + ledger/entitlement (`convex/tests/billing.test.ts`). Requires `_generated` (run `npx convex dev` once to codegen).
- Drive a webhook by hand: use `signWebhook(id, timestamp, body, secret)` from
  `convex/lib/polarSignature.ts` to build a valid `webhook-signature`, then
  `curl` your local `/polar/webhook` with the three headers and a JSON body
  shaped like `{ "type": "order.paid", "data": { "id": "ord_x", "metadata": { "orgId": "<org id>", "packageKey": "team" }, "customer_id": "cus_x" } }`.
- Or use the Polar sandbox + the Polar CLI to forward real sandbox webhooks.

## Cutover / rollback

**Cutover (sandbox → production):**

1. Create the production products in Polar; copy their ids into the
   `POLAR_PRODUCT_*` env vars on the production Convex deployment.
2. Set `POLAR_ACCESS_TOKEN` (production token), `POLAR_API_URL`
   (`https://api.polar.sh`), `POLAR_ENV=production`, and `APP_BASE_URL`.
3. Register the production webhook endpoint and set `POLAR_WEBHOOK_SECRET`.
4. `npx convex deploy` to ship the schema + functions.
5. Smoke test: run a real low-value checkout, confirm an `order.paid` lands a
   ledger row and an `active` entitlement, then refund it and confirm the
   reversal.

**Rollback:** unset `POLAR_ACCESS_TOKEN` (and/or the `POLAR_PRODUCT_*` vars) —
checkout and portal immediately fail closed and the Billing page shows the
trial state; the app keeps working. Optionally remove the Polar webhook
endpoint. The billing tables are additive and isolated, so leaving them in
place is harmless; no eval/trace data is affected. To fully revert, redeploy
the prior commit (the four billing tables are unused by the rest of the app).

## Manual enterprise path

1. Sign the contract out of band.
2. Insert an `active` `billingEntitlements` row (`packageKey: "enterprise"`)
   and a positive `billingLedger` grant for the negotiated credits, scoped to
   the org. A tiny owner/admin-gated internal mutation is the cleanest home for
   this; the foundation intentionally ships none so credits can't be minted by
   accident.
