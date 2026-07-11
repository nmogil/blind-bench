import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseArgs, runCli } from "./blindbench";

function harness(responses: ReadonlyArray<{ readonly status?: number; readonly body: unknown }>) {
  const output: string[] = [];
  const errors: string[] = [];
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  let index = 0;
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    const next = responses[index];
    index++;
    if (!next) throw new Error("Unexpected request");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  return {
    output,
    errors,
    requests,
    fetcher,
    io: { out: (text: string) => output.push(text), error: (text: string) => errors.push(text) },
    env: { BLINDBENCH_URL: "http://127.0.0.1:9000/", BLINDBENCH_API_TOKEN: "secret-api-token" },
  };
}

describe("Blind Bench customer CLI", () => {
  test("prints help and rejects arguments deterministically", () => {
    expect(parseArgs(["--help"])).toMatchObject({ ok: true, command: { kind: "help" } });
    expect(parseArgs(["create", "--name", "Example"])).toEqual({ ok: false, error: "create requires --idempotency-key" });
    expect(parseArgs(["status", "--review-id", "one", "--review-id", "two"])).toEqual({ ok: false, error: "Duplicate argument: --review-id" });
    expect(parseArgs(["close", "--unknown", "x"])).toEqual({ ok: false, error: "Unknown argument: --unknown" });
  });

  test("uploads a synthetic eval-record without echoing the token or record content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blindbench-cli-"));
    const path = join(dir, "record.json");
    const sentinel = "PRIVATE-SYNTHETIC-CONTENT";
    await writeFile(path, JSON.stringify({ version: "1", id: "synthetic-1", input: { messages: [{ role: "user", content: sentinel }] }, output: { content: "Synthetic answer" } }));
    const h = harness([{ body: { imported: 1, deduped: 0, invalid: 0, truncated: false, malicious: sentinel } }]);
    expect(await runCli(["upload", path], h.env, h.io, h.fetcher)).toBe(0);
    expect(h.requests[0]?.url).toBe("http://127.0.0.1:9000/ingest/v1/traces");
    expect(h.requests[0]?.init?.body).toContain(sentinel);
    const rendered = [...h.output, ...h.errors].join("\n");
    expect(rendered).toContain("imported=1");
    expect(rendered).not.toContain(sentinel);
    expect(rendered).not.toContain("secret-api-token");
  });

  test("wraps create, status, and close with safe projected output", async () => {
    const h = harness([
      { body: { review_id: "review-1", status: "open", item_count: 2, review_url: "https://blindbench.dev/review/verdict/opaque", raw: "DO-NOT-PRINT" } },
      { body: { review_id: "review-1", status: "open", item_count: 2, judgment_count: 1, reviewed_item_count: 1, aggregate: { best: 1, acceptable: 0, weak: 0, disagreement: 0 }, comments: "DO-NOT-PRINT" } },
      { body: { review_id: "review-1", status: "closed", item_count: 2, judgment_count: 1, reviewed_item_count: 1, aggregate: { best: 1, acceptable: 0, weak: 0, disagreement: 0 } } },
    ]);
    expect(await runCli(["create", "--name", "Example", "--idempotency-key", "ci-1", "--trace-id", "trace-a", "--trace-id", "trace-b"], h.env, h.io, h.fetcher)).toBe(0);
    expect(await runCli(["status", "--review-id", "review-1"], h.env, h.io, h.fetcher)).toBe(0);
    expect(await runCli(["close", "--review-id", "review-1"], h.env, h.io, h.fetcher)).toBe(0);
    expect(h.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:9000/api/v1/reviews",
      "http://127.0.0.1:9000/api/v1/reviews?id=review-1",
      "http://127.0.0.1:9000/api/v1/reviews/close",
    ]);
    const rendered = [...h.output, ...h.errors].join("\n");
    expect(rendered).toContain("Reviewer URL: https://blindbench.dev/review/verdict/opaque");
    expect(rendered).not.toContain("DO-NOT-PRINT");
    expect(rendered).not.toContain("secret-api-token");
  });

  test("HTTP failures never print response bodies", async () => {
    const h = harness([{ status: 400, body: { error: "PRIVATE-CONTENT secret-api-token" } }]);
    expect(await runCli(["status", "--review-id", "review-1"], h.env, h.io, h.fetcher)).toBe(1);
    expect(h.errors).toEqual(["Blind Bench request failed (HTTP 400)."]);
  });

  test("rejects insecure remote URLs and partial uploads", async () => {
    const insecure = harness([]);
    expect(await runCli(
      ["status", "--review-id", "review-1"],
      { ...insecure.env, BLINDBENCH_URL: "http://example.test" },
      insecure.io,
      insecure.fetcher,
    )).toBe(2);
    expect(insecure.requests).toHaveLength(0);

    const dir = await mkdtemp(join(tmpdir(), "blindbench-cli-"));
    const path = join(dir, "record.json");
    await writeFile(path, JSON.stringify({
      version: "1",
      input: { messages: [{ role: "user", content: "Synthetic" }] },
    }));
    const partial = harness([
      { body: { imported: 0, deduped: 0, invalid: 1, truncated: false } },
    ]);
    expect(await runCli(["upload", path], partial.env, partial.io, partial.fetcher)).toBe(1);
    expect(partial.errors).toEqual([
      "Blind Bench rejected or truncated part of the upload.",
    ]);
  });

  test("fails closed on malformed successful responses", async () => {
    const malformed = harness([{ body: {} }]);
    expect(await runCli(
      ["create", "--name", "Example", "--idempotency-key", "key", "--trace-id", "trace-a"],
      malformed.env,
      malformed.io,
      malformed.fetcher,
    )).toBe(1);
    expect(malformed.output).toEqual([]);
    expect(malformed.errors).toEqual(["Blind Bench returned an invalid response."]);
  });
});
