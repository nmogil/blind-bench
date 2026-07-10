import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildCustomerTestingReadinessReport,
  formatCustomerTestingReadinessJson,
  formatCustomerTestingReadinessMarkdown,
  readApprovalsFile,
  writeCustomerTestingReadinessReport,
} from "../src/lib/evals/customerTestingReadiness";

interface Args {
  approvalsPath?: string;
  json: boolean;
  outDir: string;
}

function usage(): string {
  return [
    "usage: customer-testing-readiness [--approvals <file>] [--out <dir>] [--json]",
    "",
    "Local-only readiness gate for real operator/customer trace imports.",
    "Defaults to blocked until an approvals JSON file sets every required gate to true.",
  ].join("\n");
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, outDir: "artifacts/customer-testing-readiness" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--approvals") {
      const value = argv[++i];
      if (!value) throw new Error("--approvals requires a local JSON file");
      args.approvalsPath = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a directory");
      args.outDir = value;
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

  let approvals;
  if (args.approvalsPath) {
    if (!existsSync(args.approvalsPath)) {
      process.stderr.write("customer-testing-readiness: approvals file not found.\n");
      return 2;
    }
    try {
      approvals = readApprovalsFile(args.approvalsPath);
    } catch {
      process.stderr.write("customer-testing-readiness: approvals file must be valid JSON.\n");
      return 2;
    }
  }

  const report = buildCustomerTestingReadinessReport({
    approvals,
    outDir: args.outDir,
    generatedAt: new Date().toISOString(),
  });
  writeCustomerTestingReadinessReport(report);
  process.stdout.write(args.json ? formatCustomerTestingReadinessJson(report) : formatCustomerTestingReadinessMarkdown(report));
  return report.status === "ready_for_customer_testing" ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2)).then((code) => process.exit(code));
