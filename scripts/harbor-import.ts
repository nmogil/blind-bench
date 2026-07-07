/**
 * #268 (M31.5) — Harbor run dir → normalized AgentRunTrace JSON.
 *
 * SPIKE scope: implements the `claude-code` combo by reusing the verified M31.2
 * parser (Harbor runs the real agent, so a claude-code trajectory IS a Claude
 * Code session .jsonl). Other agents throw a named-adapter error until we have a
 * real output sample (see docs/harbor-matrix-spike.md §3). Zero sandbox infra.
 *
 * Usage:
 *   npx tsx scripts/harbor-import.ts <harbor-run-dir> --out ./harbor-traces [--agent claude-code]
 *   npx tsx scripts/harbor-import.ts --selfcheck
 *
 * The exact Harbor output layout is unconfirmed (no run in this environment);
 * we glob *.jsonl trajectories recursively and record the assumption. Output is
 * one AgentRunTrace JSON per trajectory, ready to import via the spine
 * (importClaudeCodeSession for CC, or a persistTrace call for pre-normalized).
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parseClaudeCodeSession } from "../convex/lib/claudeCodeTrace";
import type { AgentRunTrace } from "../convex/lib/agentTrace";

function walk(dir: string, hits: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, hits);
    else if (name.endsWith(".jsonl")) hits.push(p);
  }
  return hits;
}

/** Harbor combo → AgentRunTrace. Only claude-code is implemented in the spike. */
export function harborTrajectoryToTrace(
  agent: string,
  jsonl: string,
  combo: { model?: string; task?: string; env?: string; runId?: string },
): AgentRunTrace {
  if (agent !== "claude-code") {
    throw new Error(
      `No converter for Harbor agent "${agent}" yet — add a ${agent} adapter (see docs/harbor-matrix-spike.md §3). Only claude-code is implemented in this spike.`,
    );
  }
  const { trace } = parseClaudeCodeSession(jsonl);
  // Overlay Harbor run metadata onto the native trajectory.
  return {
    ...trace,
    harness: { ...trace.harness, name: "claude_code" },
    model: combo.model ?? trace.model,
    product: combo.task ?? trace.product,
    environment: combo.env ?? trace.environment,
    trace_id: combo.runId ? `harbor-${combo.runId}` : trace.trace_id,
    metadata: { ...trace.metadata, harbor: combo },
  };
}

function selfcheck(): void {
  const fixture = [
    JSON.stringify({ type: "user", uuid: "u1", sessionId: "SID", timestamp: "2026-07-07T00:00:00Z", message: { role: "user", content: "do it" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "SID", timestamp: "2026-07-07T00:00:01Z", message: { id: "m1", role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join("\n");
  const trace = harborTrajectoryToTrace("claude-code", fixture, { model: "anthropic/claude-opus-4-1", task: "tb-2.0/hello", env: "daytona", runId: "run-123" });
  if (trace.steps.length < 2) throw new Error("selfcheck failed: expected >=2 steps");
  if (trace.trace_id !== "harbor-run-123") throw new Error("selfcheck failed: harbor runId not applied");
  if (trace.model !== "anthropic/claude-opus-4-1") throw new Error("selfcheck failed: combo model not applied");
  try {
    harborTrajectoryToTrace("codex-cli", fixture, {});
    throw new Error("selfcheck failed: codex-cli should throw a named-adapter error");
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("codex-cli")) throw e;
  }
  // eslint-disable-next-line no-console
  console.log("selfcheck ok: claude-code converter + combo overlay + adapter guard");
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--selfcheck")) return selfcheck();
  const dir = argv[0];
  const out = argAfter(argv, "--out") ?? "./harbor-traces";
  const agent = argAfter(argv, "--agent") ?? "claude-code";
  if (!dir) {
    // eslint-disable-next-line no-console
    console.error("usage: npx tsx scripts/harbor-import.ts <harbor-run-dir> --out <dir> [--agent claude-code]\n       npx tsx scripts/harbor-import.ts --selfcheck");
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  const files = walk(dir);
  // eslint-disable-next-line no-console
  console.log(`found ${files.length} .jsonl trajectory file(s) under ${dir} (assumed layout — confirm against a real run)`);
  let ok = 0;
  for (const file of files) {
    try {
      const trace = harborTrajectoryToTrace(agent, readFileSync(file, "utf8"), { runId: basename(file, ".jsonl") });
      const dest = join(out, `${trace.trace_id}.json`);
      writeFileSync(dest, JSON.stringify(trace, null, 2));
      ok++;
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${basename(file)} → ${dest} (${trace.steps.length} steps)`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`  ✗ ${basename(file)}: ${(e as Error).message}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`normalized ${ok}/${files.length}. Import each via the spine (importClaudeCodeSession / persistTrace).`);
}

function argAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

main();
