#!/usr/bin/env node
/** Dependency-light customer CLI. It intentionally imports no Convex backend code. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HELP = `Blind Bench customer CLI

Usage:
  npm run blindbench -- upload <eval-record.json>
  npm run blindbench -- create --name <name> --idempotency-key <key> --trace-id <id> [--trace-id <id> ...] [--instructions <text>]
  npm run blindbench -- status --review-id <id>
  npm run blindbench -- close --review-id <id>
  npm run blindbench -- --help

Environment:
  BLINDBENCH_URL        Convex site base URL, for example https://example.convex.site
  BLINDBENCH_API_TOKEN  Project token with the command's required scopes
`;

type Io = { readonly out: (text: string) => void; readonly error: (text: string) => void };
type Env = Readonly<Record<string, string | undefined>>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ParsedCommand =
  | { readonly kind: "help" }
  | { readonly kind: "upload"; readonly path: string }
  | { readonly kind: "create"; readonly name: string; readonly instructions?: string; readonly idempotencyKey: string; readonly traceIds: ReadonlyArray<string> }
  | { readonly kind: "status"; readonly reviewId: string }
  | { readonly kind: "close"; readonly reviewId: string };

type ParseOutcome = { readonly ok: true; readonly command: ParsedCommand } | { readonly ok: false; readonly error: string };

function parseFlags(args: ReadonlyArray<string>, allowed: ReadonlySet<string>, repeatable: ReadonlySet<string> = new Set()): ParseOutcome | Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !allowed.has(flag)) return { ok: false, error: `Unknown argument: ${flag ?? ""}` };
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `Missing value for ${flag}` };
    const prior = values.get(flag) ?? [];
    if (prior.length > 0 && !repeatable.has(flag)) return { ok: false, error: `Duplicate argument: ${flag}` };
    prior.push(value);
    values.set(flag, prior);
  }
  return values;
}

/** Parse CLI arguments without reading environment, disk, or network state. */
export function parseArgs(argv: ReadonlyArray<string>): ParseOutcome {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { ok: true, command: { kind: "help" } };
  const command = argv[0];
  if (command === "upload") {
    if (argv.length !== 2 || argv[1] === undefined || argv[1].startsWith("--")) return { ok: false, error: "upload requires exactly one artifact path" };
    return { ok: true, command: { kind: "upload", path: argv[1] } };
  }
  if (command === "create") {
    const flags = parseFlags(argv.slice(1), new Set(["--name", "--instructions", "--idempotency-key", "--trace-id"]), new Set(["--trace-id"]));
    if (!(flags instanceof Map)) return flags;
    const name = flags.get("--name")?.[0]?.trim() ?? "";
    const idempotencyKey = flags.get("--idempotency-key")?.[0]?.trim() ?? "";
    const traceIds = (flags.get("--trace-id") ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
    if (!name) return { ok: false, error: "create requires --name" };
    if (!idempotencyKey) return { ok: false, error: "create requires --idempotency-key" };
    if (traceIds.length === 0) return { ok: false, error: "create requires at least one --trace-id" };
    if (traceIds.length > 50) return { ok: false, error: "create accepts at most 50 --trace-id values" };
    if (new Set(traceIds).size !== traceIds.length) return { ok: false, error: "create does not accept duplicate --trace-id values" };
    const instructions = flags.get("--instructions")?.[0]?.trim();
    return { ok: true, command: { kind: "create", name, ...(instructions ? { instructions } : {}), idempotencyKey, traceIds } };
  }
  if (command === "status" || command === "close") {
    const flags = parseFlags(argv.slice(1), new Set(["--review-id"]));
    if (!(flags instanceof Map)) return flags;
    const reviewId = flags.get("--review-id")?.[0]?.trim() ?? "";
    if (!reviewId) return { ok: false, error: `${command} requires --review-id` };
    return { ok: true, command: { kind: command, reviewId } };
  }
  return { ok: false, error: `Unknown command: ${command}` };
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeNumber(record: Record<string, unknown>, key: string): number {
  return typeof record[key] === "number" ? record[key] : 0;
}

function safeString(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? record[key] : "";
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Blind Bench returned an invalid response.");
  }
  return value;
}

function requireCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Blind Bench returned an invalid response.");
  }
  return value;
}

function validateUploadResponse(record: Record<string, unknown>): void {
  requireCount(record, "imported");
  requireCount(record, "deduped");
  requireCount(record, "invalid");
  if (typeof record.truncated !== "boolean") {
    throw new Error("Blind Bench returned an invalid response.");
  }
}

function validateCreateResponse(record: Record<string, unknown>): void {
  requireString(record, "review_id");
  requireString(record, "status");
  requireCount(record, "item_count");
  const reviewUrl = requireString(record, "review_url");
  let parsed: URL;
  try {
    parsed = new URL(reviewUrl);
  } catch {
    throw new Error("Blind Bench returned an invalid response.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Blind Bench returned an invalid response.");
  }
}

function validateStatusResponse(record: Record<string, unknown>): void {
  requireString(record, "review_id");
  requireString(record, "status");
  requireCount(record, "item_count");
  requireCount(record, "judgment_count");
  requireCount(record, "reviewed_item_count");
  const aggregate = safeObject(record.aggregate);
  for (const key of ["best", "acceptable", "weak", "disagreement"]) {
    requireCount(aggregate, key);
  }
}

async function request(fetcher: Fetch, url: string, token: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
  } catch {
    throw new Error("Could not reach Blind Bench.");
  }
  if (!response.ok) throw new Error(`Blind Bench request failed (HTTP ${response.status}).`);
  try {
    const value: unknown = await response.json();
    return safeObject(value);
  } catch {
    throw new Error("Blind Bench returned an invalid JSON response.");
  }
}

/** Execute one command through injectable IO/fetch seams. Returns a process exit code. */
export async function runCli(
  argv: ReadonlyArray<string>,
  env: Env = process.env,
  io: Io = { out: (text) => process.stdout.write(`${text}\n`), error: (text) => process.stderr.write(`${text}\n`) },
  fetcher: Fetch = fetch,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.error(`${parsed.error}\nRun with --help for usage.`);
    return 2;
  }
  if (parsed.command.kind === "help") {
    io.out(HELP.trimEnd());
    return 0;
  }
  const baseUrl = env.BLINDBENCH_URL?.trim().replace(/\/+$/, "");
  const token = env.BLINDBENCH_API_TOKEN?.trim();
  let parsedBaseUrl: URL | undefined;
  try {
    parsedBaseUrl = baseUrl ? new URL(baseUrl) : undefined;
  } catch {
    parsedBaseUrl = undefined;
  }
  const loopback = parsedBaseUrl?.hostname === "127.0.0.1"
    || parsedBaseUrl?.hostname === "localhost"
    || parsedBaseUrl?.hostname === "::1";
  if (!parsedBaseUrl || (parsedBaseUrl.protocol !== "https:" && !loopback)) {
    io.error("BLINDBENCH_URL must use HTTPS (HTTP is allowed only for loopback testing).");
    return 2;
  }
  if (!token) {
    io.error("BLINDBENCH_API_TOKEN is required.");
    return 2;
  }

  try {
    if (parsed.command.kind === "upload") {
      let raw: string;
      try {
        raw = await readFile(parsed.command.path, "utf8");
        JSON.parse(raw);
      } catch {
        io.error("Could not read a valid JSON artifact.");
        return 2;
      }
      const result = await request(fetcher, `${baseUrl}/ingest/v1/traces`, token, { method: "POST", body: raw });
      validateUploadResponse(result);
      if (safeNumber(result, "invalid") > 0 || result.truncated === true) {
        throw new Error("Blind Bench rejected or truncated part of the upload.");
      }
      io.out(`Upload complete: imported=${safeNumber(result, "imported")} deduped=${safeNumber(result, "deduped")} invalid=${safeNumber(result, "invalid")}`);
      return 0;
    }
    if (parsed.command.kind === "create") {
      const result = await request(fetcher, `${baseUrl}/api/v1/reviews`, token, {
        method: "POST",
        body: JSON.stringify({ name: parsed.command.name, ...(parsed.command.instructions ? { instructions: parsed.command.instructions } : {}), trace_ids: parsed.command.traceIds, idempotency_key: parsed.command.idempotencyKey }),
      });
      validateCreateResponse(result);
      io.out(`Review ${safeString(result, "review_id")} is ${safeString(result, "status")} (${safeNumber(result, "item_count")} runs).`);
      io.out(`Reviewer URL: ${safeString(result, "review_url")}`);
      return 0;
    }
    const reviewId = encodeURIComponent(parsed.command.reviewId);
    const result = parsed.command.kind === "status"
      ? await request(fetcher, `${baseUrl}/api/v1/reviews?id=${reviewId}`, token, { method: "GET" })
      : await request(fetcher, `${baseUrl}/api/v1/reviews/close`, token, { method: "POST", body: JSON.stringify({ review_id: parsed.command.reviewId }) });
    validateStatusResponse(result);
    io.out(`Review ${safeString(result, "review_id")} is ${safeString(result, "status")}: items=${safeNumber(result, "item_count")} judgments=${safeNumber(result, "judgment_count")}.`);
    return 0;
  } catch (cause: unknown) {
    io.error(cause instanceof Error ? cause.message : "Blind Bench command failed.");
    return 1;
  }
}

const direct = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) process.exitCode = await runCli(process.argv.slice(2));
