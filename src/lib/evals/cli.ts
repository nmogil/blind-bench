/**
 * Local eval CLI — runs a pack's synthetic fixtures through its scorers and
 * writes JSON + Markdown summaries. No network, no hosted infra.
 *
 *   npx tsx src/lib/evals/cli.ts \
 *     --pack customer-pilot/smoke \
 *     --source fixtures \
 *     --output /tmp/blindbench-report.json \
 *     --markdown /tmp/blindbench-report.md \
 *     --allow-failures
 *
 * Exit code: non-zero when any case hard-fails, UNLESS --allow-failures is set.
 * The default customer-pilot/smoke pack ships one intentional hard-fail fixture, so it
 * exits non-zero without --allow-failures (proving the gate).
 *
 * Baseline vs candidate (optional):
 *   --candidate-fixtures <file.json>   override fixtures (caseId -> AgentOutput)
 *   --baseline-fixtures  <file.json>   second set to diff against (regressions/fixes)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { AgentOutput } from "./evalCase";
import {
  compareSummaries,
  formatJson,
  formatMarkdown,
  runPack,
} from "./runner";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/** Load + validate a caseId -> AgentOutput fixture file. */
function loadFixtures(path: string): Record<string, AgentOutput> {
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const out: Record<string, AgentOutput> = {};
  for (const [id, raw] of Object.entries(data)) out[id] = AgentOutput.parse(raw);
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv);
  const pack = (flags.pack as string) ?? "customer-pilot/smoke";
  const allowFailures = flags["allow-failures"] === true;

  const candidateFixtures = flags["candidate-fixtures"]
    ? loadFixtures(flags["candidate-fixtures"] as string)
    : undefined;
  const summary = await runPack(pack, candidateFixtures);

  let comparison;
  if (flags["baseline-fixtures"]) {
    const baseline = await runPack(pack, loadFixtures(flags["baseline-fixtures"] as string));
    comparison = compareSummaries(baseline, summary);
  }

  const json = formatJson(summary, comparison);
  const md = formatMarkdown(summary, comparison);
  if (flags.output) writeFileSync(flags.output as string, json);
  if (flags.markdown) writeFileSync(flags.markdown as string, md);

  // Console summary (the Markdown table is the human view).
  process.stdout.write(md + "\n");
  if (summary.missing_fixtures.length) {
    process.stdout.write(
      `Note: ${summary.missing_fixtures.length} case(s) skipped (no fixture).\n`,
    );
  }

  if (summary.hard_failed > 0 && !allowFailures) {
    process.stderr.write(
      `\n${summary.hard_failed} hard-fail(s). Exiting non-zero (pass --allow-failures to override).\n`,
    );
    return 1;
  }
  return 0;
}

// Run when invoked directly (tsx/node), not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
