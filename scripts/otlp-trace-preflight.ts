/**
 * #298: local-only OTLP/Gen-AI payload preflight (no network, no ingest).
 *
 *   npx tsx scripts/otlp-trace-preflight.ts <payload.json>
 *   npx tsx scripts/otlp-trace-preflight.ts <payload.json> --json
 *
 * Reads a captured/exported OTLP JSON payload from disk, runs it through the SAME
 * `mapOtlpToTraces` used by the live `/otlp/v1/traces` importer, and prints a
 * management-safe summary (counts, model/harness names, capped trace-id suffixes,
 * readiness + caveats). It NEVER POSTs anywhere, imports into Convex, reads/prints
 * ingest tokens, or echoes raw prompts/completions/span bodies/account ids/invalid
 * JSON — the summary is built only from counts and label-only fields.
 *
 * Exit codes: 0 = traces mapped; 1 = zero traces mapped; 2 = bad input (missing
 * arg, missing file, invalid JSON).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mapOtlpToTraces } from "../convex/lib/otelGenAI";
import {
  buildPreflightSummary,
  renderPreflightText,
  type PreflightSummary,
} from "../convex/lib/otlpPreflight";

export interface CliArgs {
  path?: string;
  json: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const json = argv.includes("--json");
  const path = argv.find((a) => a !== "--json" && !a.startsWith("-"));
  return { path, json };
}

const USAGE = "usage: npx tsx scripts/otlp-trace-preflight.ts <payload.json> [--json]";

/** Result of turning a file into a summary — or a safe error (no raw content). */
type PreflightOutcome =
  | { ok: true; summary: PreflightSummary }
  | { ok: false; code: 1 | 2; message: string };

/**
 * Pure core: path → outcome. Injectable reader so it stays testable without disk.
 * Parse/read failures return generic messages — never the file bytes or parser
 * snippet, which can echo the payload (and thus sentinels/credentials).
 */
export function runPreflight(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): PreflightOutcome {
  let raw: string;
  try {
    raw = read(path);
  } catch {
    return { ok: false, code: 2, message: `Cannot read file: ${path}` };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Intentionally omit the parser message — it can contain payload bytes.
    return { ok: false, code: 2, message: `Invalid JSON: ${path}` };
  }
  const summary = buildPreflightSummary(mapOtlpToTraces(payload));
  if (summary.traces === 0) {
    return {
      ok: false,
      code: 1,
      message: `No traces mapped from ${path}. ${summary.caveats.join(" ")}`,
    };
  }
  return { ok: true, summary };
}

export function main(argv: string[]): number {
  const { path, json } = parseArgs(argv);
  if (!path) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const outcome = runPreflight(path);
  if (!outcome.ok) {
    process.stderr.write(`${outcome.message}\n`);
    return outcome.code;
  }
  process.stdout.write(
    (json ? JSON.stringify(outcome.summary, null, 2) : renderPreflightText(outcome.summary)) + "\n",
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
