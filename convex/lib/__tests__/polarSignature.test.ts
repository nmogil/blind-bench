import { describe, test, expect } from "vitest";
import { signWebhook, verifyWebhook } from "../polarSignature";

const secret = "whsec_" + btoa("super-secret-key-for-testing-only");
const id = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
const body = JSON.stringify({ type: "order.paid", data: { id: "ord_1" } });
const now = 1_700_000_000_000;
const timestamp = String(Math.floor(now / 1000));

describe("polar webhook signature", () => {
  test("verifies a signature it produced", async () => {
    const signature = await signWebhook(id, timestamp, body, secret);
    expect(
      await verifyWebhook({ id, timestamp, signature, body, secret, nowMs: now }),
    ).toBe(true);
  });

  test("rejects a tampered body", async () => {
    const signature = await signWebhook(id, timestamp, body, secret);
    expect(
      await verifyWebhook({
        id,
        timestamp,
        signature,
        body: body + " ",
        secret,
        nowMs: now,
      }),
    ).toBe(false);
  });

  test("rejects a wrong secret", async () => {
    const signature = await signWebhook(id, timestamp, body, secret);
    expect(
      await verifyWebhook({
        id,
        timestamp,
        signature,
        body,
        secret: "whsec_" + btoa("different-key"),
        nowMs: now,
      }),
    ).toBe(false);
  });

  test("rejects a stale timestamp outside tolerance", async () => {
    const signature = await signWebhook(id, timestamp, body, secret);
    expect(
      await verifyWebhook({
        id,
        timestamp,
        signature,
        body,
        secret,
        nowMs: now + 10 * 60 * 1000, // 10 min later, tolerance is 5 min
      }),
    ).toBe(false);
  });

  test("accepts a plain (non-whsec) secret as utf-8", async () => {
    const plain = "plain-secret";
    const signature = await signWebhook(id, timestamp, body, plain);
    expect(
      await verifyWebhook({
        id,
        timestamp,
        signature,
        body,
        secret: plain,
        nowMs: now,
      }),
    ).toBe(true);
  });

  test("accepts any matching entry among rotated signatures", async () => {
    const valid = await signWebhook(id, timestamp, body, secret);
    const signature = `v1,bogussignaturevalue ${valid}`;
    expect(
      await verifyWebhook({ id, timestamp, signature, body, secret, nowMs: now }),
    ).toBe(true);
  });
});
