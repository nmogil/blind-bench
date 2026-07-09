import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  formatClaudeCodePreflightJson,
  formatClaudeCodePreflightText,
  summarizeClaudeCodePreflight,
} from "../convex/lib/claudeCodePreflight";

interface CliOptions {
  file?: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { json: false };
  for (const arg of argv) {
    if (arg === "--json") {
      opts.json = true;
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
  const msg = `usage: npx tsx scripts/claude-code-session-preflight.ts <session.jsonl> [--json]\n\nLocal-only, management-safe preflight for a Claude Code session transcript.\nDoes not upload, import, or print raw transcript content.\n`;
  (code === 0 ? console.log : console.error)(msg);
  process.exit(code);
}

function fail(message: string): never {
  console.error(`Claude Code preflight failed: ${message}`);
  process.exit(1);
}

export function runCli(argv = process.argv.slice(2)): void {
  const opts = parseArgs(argv);
  if (!opts.file) printUsage(1);
  if (!existsSync(opts.file)) fail(`file not found: ${opts.file}`);
  const stat = statSync(opts.file);
  if (!stat.isFile()) fail(`not a file: ${opts.file}`);
  if (stat.size === 0) fail("file is empty");

  const jsonl = readFileSync(opts.file, "utf8");
  if (!jsonl.trim()) fail("file contains only whitespace");
  const summary = summarizeClaudeCodePreflight(jsonl);
  const output = opts.json ? formatClaudeCodePreflightJson(summary) : formatClaudeCodePreflightText(summary);
  process.stdout.write(output);
  if (summary.status !== "ready") process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) runCli();
