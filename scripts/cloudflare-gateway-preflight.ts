import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  formatGatewayPreflightJson,
  formatGatewayPreflightText,
  summarizeGatewayPreflight,
} from "../convex/traceAdapters/cloudflareGatewayPreflight";

interface CliOptions {
  file?: string;
  sidecar?: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--sidecar") {
      const next = argv[++i];
      if (!next) fail("--sidecar requires a file path");
      opts.sidecar = next;
    } else if (arg === "--help" || arg === "-h") {
      printUsage(0);
    } else if (!opts.file) {
      opts.file = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }
  return opts;
}

function printUsage(code: number): never {
  const msg = `usage: npx tsx scripts/cloudflare-gateway-preflight.ts <gateway.jsonl> [--sidecar metadata.json] [--json]\n\nLocal-only, management-safe preflight for a customer-owned Cloudflare AI Gateway JSONL export.\nDoes not upload, import, call Cloudflare, or print raw trace content.\n`;
  (code === 0 ? console.log : console.error)(msg);
  process.exit(code);
}

function fail(message: string): never {
  console.error(`Cloudflare Gateway preflight failed: ${message}`);
  process.exit(1);
}

function readRequiredFile(path: string, label: string): string {
  if (!existsSync(path)) fail(`${label} file not found: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) fail(`${label} path is not a file: ${path}`);
  if (stat.size === 0) fail(`${label} file is empty`);
  const text = readFileSync(path, "utf8");
  if (!text.trim()) fail(`${label} file contains only whitespace`);
  return text;
}

export function runCli(argv = process.argv.slice(2)): void {
  const opts = parseArgs(argv);
  if (!opts.file) printUsage(1);
  const jsonl = readRequiredFile(opts.file, "Gateway JSONL");
  const sidecarJson = opts.sidecar ? readRequiredFile(opts.sidecar, "Sidecar") : undefined;
  const summary = summarizeGatewayPreflight(jsonl, { sidecarJson });
  process.stdout.write(opts.json ? formatGatewayPreflightJson(summary) : formatGatewayPreflightText(summary));
  if (summary.status !== "ready") process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) runCli();
