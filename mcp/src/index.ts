#!/usr/bin/env node
/**
 * Blind Bench MCP server. Reads BLINDBENCH_TOKEN and BLINDBENCH_API_BASE
 * from the environment, registers the tools defined in tools.ts, and runs
 * over stdio for use with Claude Code, Cursor, or any MCP-compatible client.
 *
 * Add to ~/.config/claude-code/mcp.json (or project .mcp.json):
 * {
 *   "mcpServers": {
 *     "blind-bench": {
 *       "command": "blind-bench-mcp",
 *       "env": {
 *         "BLINDBENCH_TOKEN": "bbst_live_…",
 *         "BLINDBENCH_API_BASE": "https://your-deployment.convex.site"
 *       }
 *     }
 *   }
 * }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BlindBenchClient } from "./client.js";
import { registerTools } from "./tools.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[blind-bench-mcp] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const token = requireEnv("BLINDBENCH_TOKEN");
  const apiBase = requireEnv("BLINDBENCH_API_BASE");

  const client = new BlindBenchClient({ token, apiBase });
  const server = new McpServer({
    name: "blind-bench",
    version: "0.1.0",
  });

  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[blind-bench-mcp] fatal:", err);
  process.exit(1);
});
