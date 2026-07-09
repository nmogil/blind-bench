import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AGENT_TRACE_FIXTURE_DIR,
  AGENT_TRACE_FIXTURE_FILES,
  writeAgentTraceFixtures,
} from "../src/lib/evals/agentTraceFixtures";

function usage(): string {
  return [
    "usage: agent-trace-fixtures [--out <dir>]",
    "",
    "Writes deterministic synthetic Claude Code, Cloudflare AI Gateway, and OTLP fixtures.",
    "No network calls; no customer data; no credentials.",
  ].join("\n");
}

export function parseArgs(argv: string[]): { outDir: string } {
  let outDir = join("artifacts", AGENT_TRACE_FIXTURE_DIR);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a directory");
      outDir = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { outDir };
}

export async function main(argv: string[]): Promise<number> {
  let args: { outDir: string };
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const manifest = writeAgentTraceFixtures(args.outDir);
  const fileList = Object.values(AGENT_TRACE_FIXTURE_FILES).map((file) => join(args.outDir, file));
  const missing = fileList.filter((file) => !existsSync(file));
  if (missing.length) {
    process.stderr.write(`agent-trace-fixtures: failed to write ${missing.length} expected file(s).\n`);
    return 1;
  }

  process.stdout.write([
    "Synthetic agent trace fixtures written.",
    `  output: ${args.outDir}`,
    `  files:  ${fileList.length}`,
    `  traces: ${manifest.files.map((file) => `${file.format}=${file.traces}`).join(" ")}`,
    "  safety: synthetic only; no customer data; no credentials; no network calls",
    "",
  ].join("\n"));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2)).then((code) => process.exit(code));
