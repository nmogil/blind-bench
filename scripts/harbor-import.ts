/**
 * #268 (M31.5) — Harbor run dir → normalized AgentRunTrace JSON.
 *
 * Verified against a REAL `harbor run … --agent claude-code --env daytona` output
 * (2026-07-07). Harbor's claude-code agent writes a genuine Claude Code session
 * transcript at `<trial>/agent/sessions/projects/<slug>/<uuid>.jsonl` — exactly
 * the format the M31.2 parser (parseClaudeCodeSession) already handles — plus a
 * Harbor-normalized `<trial>/agent/trajectory.json` (alt format, not used here)
 * and per-job cost/model metadata in `<run>/result.json`. So the converter
 * reuses the verified CC parser and overlays Harbor combo metadata. Zero sandbox
 * infra.
 *
 * Usage:
 *   npx tsx scripts/harbor-import.ts <jobs-root> --out ./harbor-traces
 *   npx tsx scripts/harbor-import.ts --selfcheck
 * where <jobs-root> has one subdir per combo (e.g. opus/, sonnet/, haiku/), each
 * a `harbor run -o <jobs-root>/<combo>` output. One AgentRunTrace JSON per combo.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { parseClaudeCodeSession } from "../convex/lib/claudeCodeTrace";
import type { AgentRunTrace } from "../convex/lib/agentTrace";

interface Combo {
  combo: string;
  model: string;
  task: string;
  runId: string;
  costUsd?: number;
  reward?: number;
}

/** Overlay Harbor combo metadata onto a parsed Claude Code session trace. */
export function harborSessionToTrace(jsonl: string, combo: Combo): AgentRunTrace {
  const { trace } = parseClaudeCodeSession(jsonl);
  return {
    ...trace,
    harness: { ...trace.harness, name: "claude_code" },
    model: combo.model,
    product: combo.task,
    trace_id: `harbor-${combo.runId}`,
    metadata: { ...trace.metadata, harbor: combo },
  };
}

function readJson(p: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function walk(dir: string, ext: string, hits: string[] = []): string[] {
  if (!existsSync(dir)) return hits;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, hits);
    else if (name.endsWith(ext)) hits.push(p);
  }
  return hits;
}

/** The main CC session transcript in a trial (largest .jsonl under sessions/projects). */
function findSession(trialDir: string): string | undefined {
  const jsonls = walk(join(trialDir, "agent", "sessions", "projects"), ".jsonl");
  return jsonls.sort((a, b) => statSync(b).size - statSync(a).size)[0];
}

function comboFromJob(runDir: string, comboName: string, trialDir: string): Combo {
  const job = readJson(join(runDir, "result.json")) ?? {};
  const stats = (job.stats ?? {}) as Record<string, unknown>;
  const evals = (stats.evals ?? {}) as Record<string, unknown>;
  const evalKey = Object.keys(evals)[0] ?? "";
  // eval key looks like "claude-code__claude-opus-4-1__terminal-bench"
  const model = evalKey.split("__")[1] || comboName;
  const rewardStats = ((evals[evalKey] as Record<string, unknown>)?.reward_stats ?? {}) as Record<string, unknown>;
  const rewardBucket = Object.keys((rewardStats.reward ?? {}) as Record<string, unknown>)[0];
  return {
    combo: comboName,
    model,
    task: "fix-git",
    runId: `${comboName}-${basename(trialDir)}`,
    costUsd: typeof stats.cost_usd === "number" ? stats.cost_usd : undefined,
    reward: rewardBucket !== undefined ? Number(rewardBucket) : undefined,
  };
}

function processComboDir(comboDir: string): { trace: AgentRunTrace; combo: Combo } | undefined {
  const runs = readdirSync(comboDir)
    .filter((d) => statSync(join(comboDir, d)).isDirectory() && /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  if (!runs.length) return undefined;
  const runDir = join(comboDir, runs[runs.length - 1]); // latest run
  const trials = readdirSync(runDir).filter((d) => existsSync(join(runDir, d, "agent")));
  if (!trials.length) return undefined;
  const trialDir = join(runDir, trials[0]);
  const session = findSession(trialDir);
  if (!session) return undefined;
  const combo = comboFromJob(runDir, basename(comboDir), trialDir);
  return { trace: harborSessionToTrace(readFileSync(session, "utf8"), combo), combo };
}

function selfcheck(): void {
  const fixture = [
    JSON.stringify({ type: "user", uuid: "u1", sessionId: "SID", timestamp: "2026-07-07T00:00:00Z", message: { role: "user", content: "do it" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "SID", timestamp: "2026-07-07T00:00:01Z", message: { id: "m1", role: "assistant", model: "x", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join("\n");
  const trace = harborSessionToTrace(fixture, { combo: "opus", model: "anthropic/claude-opus-4-1", task: "fix-git", runId: "opus-x", costUsd: 0.2, reward: 1 });
  if (trace.steps.length < 2) throw new Error("selfcheck: expected >=2 steps");
  if (trace.trace_id !== "harbor-opus-x") throw new Error("selfcheck: runId not applied");
  if (trace.model !== "anthropic/claude-opus-4-1") throw new Error("selfcheck: model not applied");
  // eslint-disable-next-line no-console
  console.log("selfcheck ok");
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--selfcheck")) return selfcheck();
  const root = argv[0];
  const out = argv[argv.indexOf("--out") + 1] || "./harbor-traces";
  if (!root) {
    // eslint-disable-next-line no-console
    console.error("usage: npx tsx scripts/harbor-import.ts <jobs-root> --out <dir>   |   --selfcheck");
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  const combos = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
  const summary: Combo[] = [];
  for (const comboName of combos) {
    const r = processComboDir(join(root, comboName));
    if (!r) {
      // eslint-disable-next-line no-console
      console.warn(`  ✗ ${comboName}: no CC session found`);
      continue;
    }
    const dest = join(out, `${comboName}.json`);
    writeFileSync(dest, JSON.stringify(r.trace, null, 2));
    summary.push(r.combo);
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${comboName}: ${r.trace.steps.length} steps, model=${r.combo.model}, cost=$${r.combo.costUsd}, reward=${r.combo.reward} → ${dest}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\ncost/reward table:\n${summary.map((c) => `  ${c.combo}\t${c.model}\t$${c.costUsd}\treward ${c.reward}`).join("\n")}`);
}

main();
