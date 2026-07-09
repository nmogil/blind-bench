import { pathToFileURL } from "node:url";
import {
  buildEvaluationRowExportBundle,
  formatEvaluationRowExportManifest,
  writeEvaluationRowExportBundle,
} from "../src/lib/evals/evaluationRowExport";

interface Args {
  outDir: string;
  json: boolean;
  generatedAt?: string;
}

function usage(): string {
  return [
    "usage: evaluation-row-export [--out <dir>] [--generated-at <iso>] [--json]",
    "",
    "Local-only synthetic EvaluationRow-compatible JSONL export for optional Fireworks/Eval Protocol handoff.",
  ].join("\n");
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { outDir: "artifacts/evaluation-row-export", json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a directory");
      args.outDir = value;
    } else if (arg === "--generated-at") {
      const value = argv[++i];
      if (!value) throw new Error("--generated-at requires an ISO timestamp");
      args.generatedAt = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const bundle = buildEvaluationRowExportBundle({ generated_at: args.generatedAt });
  writeEvaluationRowExportBundle(bundle, args.outDir);
  process.stdout.write(args.json ? formatEvaluationRowExportManifest(bundle.manifest) : bundle.reportMarkdown);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2)).then((code) => process.exit(code));
