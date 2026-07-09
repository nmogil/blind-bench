import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  formatTrainingExportVerificationJson,
  formatTrainingExportVerificationText,
  verifyTrainingExportArtifacts,
} from "../src/lib/evals/trainingExportVerifier";

interface Args {
  artifactDir?: string;
  json: boolean;
  blockedSubstrings: string[];
}

function usage(): string {
  return [
    "usage: training-export-verify <artifact-dir> [--json] [--block-substring <value> ...]",
    "",
    "Validates training-dataset.{train,validation,test}.jsonl plus training-dataset.manifest.json.",
    "No network calls; never prints raw row content or blocked substring values.",
  ].join("\n");
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, blockedSubstrings: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--block-substring") {
      const value = argv[++i];
      if (!value) throw new Error("--block-substring requires a value");
      args.blockedSubstrings.push(value);
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    } else if (!args.artifactDir) {
      args.artifactDir = arg;
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
  if (!args.artifactDir) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (!existsSync(args.artifactDir) || !statSync(args.artifactDir).isDirectory()) {
    process.stderr.write("training-export-verify: artifact directory not found or not a directory.\n");
    return 2;
  }

  const summary = verifyTrainingExportArtifacts({
    artifactDir: args.artifactDir,
    blockedSubstrings: args.blockedSubstrings,
  });
  process.stdout.write(args.json ? formatTrainingExportVerificationJson(summary) : formatTrainingExportVerificationText(summary));
  return summary.readiness === "ready" ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
