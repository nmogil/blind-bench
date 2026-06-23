/**
 * Regenerate the checked-in JSON Schema artifacts from the zod source of truth.
 * Run: npx tsx schemas/generate.ts
 * Drift is guarded by src/lib/evals/evalCase.test.ts.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evalCaseJsonSchema, evalResultJsonSchema } from "../src/lib/evals/evalCase";

const here = dirname(fileURLToPath(import.meta.url));
const write = (name: string, schema: unknown) =>
  writeFileSync(join(here, name), JSON.stringify(schema, null, 2) + "\n");

write("eval-case.schema.json", evalCaseJsonSchema);
write("eval-result.schema.json", evalResultJsonSchema);
console.log("wrote schemas/eval-case.schema.json, schemas/eval-result.schema.json");
