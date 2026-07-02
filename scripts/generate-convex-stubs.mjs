/* Generate deterministic convex/_generated stubs for preview-CI typecheck.
 *
 * Vercel preview builds have no CONVEX_DEPLOY_KEY, so `convex deploy` (which
 * normally writes convex/_generated) never runs and the type gates can't see
 * the generated `api`/`server`/`dataModel` modules. This script reconstructs
 * those files just well enough to typecheck against — it reproduced Vercel's
 * `convex deploy` typecheck output byte-for-byte on 2026-07-02.
 *
 * Real codegen ALWAYS wins: if convex/_generated/api.d.ts already exists
 * (locally, or after a real `convex deploy`), this script exits 0 and touches
 * nothing. See docs/preview-typecheck-builds.md.
 *
 * ESM, Node 20+, only node: builtins. No dependencies.
 */
import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const convexDir = fileURLToPath(new URL("../convex/", import.meta.url));
const generatedDir = join(convexDir, "_generated");

// Real codegen wins — never clobber it.
if (existsSync(join(generatedDir, "api.d.ts"))) {
  console.log(
    "convex/_generated/api.d.ts already exists — leaving real codegen in place (no stubs written).",
  );
  process.exit(0);
}

const EXCLUDED_DIRS = new Set(["_generated", "tests", "fixtures"]);

/** Walk convex/ and collect module paths (relative to convex/, no extension). */
function collectModules(dir) {
  const modules = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      modules.push(...collectModules(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    if (entry.name.endsWith(".config.ts")) continue;
    if (entry.name === "schema.ts") continue;
    // module path relative to convex/, forward slashes, no extension
    const rel = relative(convexDir, full).replace(/\\/g, "/").replace(/\.ts$/, "");
    modules.push(rel);
  }
  return modules;
}

const modules = collectModules(convexDir).sort();

// alias = module path with /, ., - replaced by _
const alias = (m) => m.replace(/[/.\-]/g, "_");

const imports = modules
  .map((m) => `import type * as ${alias(m)} from "../${m}.js";`)
  .join("\n");

const fullApiEntries = modules
  .map((m) => `  "${m}": typeof ${alias(m)};`)
  .join("\n");

const apiDts = `/* eslint-disable */
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
${imports}
declare const fullApi: ApiFromModules<{
${fullApiEntries}
}>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
`;

const dataModelDts = `/* eslint-disable */
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
} from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

export type TableNames = TableNamesInDataModel<DataModel>;
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;
export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
`;

const serverDts = `/* eslint-disable */
import {
  ActionBuilder,
  HttpActionBuilder,
  MutationBuilder,
  QueryBuilder,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  GenericDatabaseReader,
  GenericDatabaseWriter,
} from "convex/server";
import type { DataModel } from "./dataModel.js";

export declare const query: QueryBuilder<DataModel, "public">;
export declare const internalQuery: QueryBuilder<DataModel, "internal">;
export declare const mutation: MutationBuilder<DataModel, "public">;
export declare const internalMutation: MutationBuilder<DataModel, "internal">;
export declare const action: ActionBuilder<DataModel, "public">;
export declare const internalAction: ActionBuilder<DataModel, "internal">;
export declare const httpAction: HttpActionBuilder;

export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
export type DatabaseReader = GenericDatabaseReader<DataModel>;
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;
`;

const apiJs = `/* eslint-disable */
import { anyApi } from "convex/server";
export const api = anyApi;
export const internal = anyApi;
`;

const serverJs = `/* eslint-disable */
import {
  actionGeneric,
  httpActionGeneric,
  mutationGeneric,
  queryGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
} from "convex/server";
export const action = actionGeneric;
export const httpAction = httpActionGeneric;
export const mutation = mutationGeneric;
export const query = queryGeneric;
export const internalAction = internalActionGeneric;
export const internalMutation = internalMutationGeneric;
export const internalQuery = internalQueryGeneric;
`;

mkdirSync(generatedDir, { recursive: true });
writeFileSync(join(generatedDir, "api.d.ts"), apiDts);
writeFileSync(join(generatedDir, "dataModel.d.ts"), dataModelDts);
writeFileSync(join(generatedDir, "server.d.ts"), serverDts);
writeFileSync(join(generatedDir, "api.js"), apiJs);
writeFileSync(join(generatedDir, "server.js"), serverJs);

console.log(
  `Wrote convex/_generated stubs for ${modules.length} modules (preview typecheck only).`,
);
