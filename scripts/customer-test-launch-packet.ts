import { pathToFileURL } from "node:url";
import {
  buildCustomerTestLaunchPacket,
  formatCustomerTestLaunchPacketJson,
  formatCustomerTestLaunchPacketMarkdown,
  writeCustomerTestLaunchPacket,
} from "../src/lib/evals/customerTestLaunchPacket";

interface Args {
  customerLabel?: string;
  outDir: string;
  json: boolean;
}

function usage(): string {
  return [
    "usage: customer-test-launch-packet [--customer-label <safe-label>] [--out <dir>] [--json]",
    "",
    "Local-only launch packet generator for customer testing handoff review.",
  ].join("\n");
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { outDir: "artifacts/customer-test-launch-packet", json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--customer-label") {
      const value = argv[++i];
      if (!value) throw new Error("--customer-label requires a value");
      args.customerLabel = value;
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
  const packet = buildCustomerTestLaunchPacket({
    outDir: args.outDir,
    customerLabel: args.customerLabel,
  });
  writeCustomerTestLaunchPacket(packet);
  process.stdout.write(args.json ? formatCustomerTestLaunchPacketJson(packet) : formatCustomerTestLaunchPacketMarkdown(packet));
  return packet.status === "ready_to_review" ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2)).then((code) => process.exit(code));
