/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { parseCsvTraceBatch } from "../lib/csvTrace";

const csv = [
  "run_id,prompt,response,model,provider,harness,case_key,note",
  'r-1,"Summarize this, please","First line\nSecond line",gpt-4.1,openai,custom-agent,case-1,"contains, comma"',
  'r-2,"Draft a reply","Thanks for writing",claude-sonnet-4-7,anthropic,custom-agent,case-2,plain',
].join("\r\n");

const mapping = {
  idColumn: "run_id",
  inputColumn: "prompt",
  outputColumn: "response",
  modelColumn: "model",
  providerColumn: "provider",
  harnessColumn: "harness",
  metadataColumns: ["case_key", "note"],
} as const;

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", { name: "Owner", email: "owner@test.com" });
    const reviewerUserId = await ctx.db.insert("users", { name: "Reviewer", email: "reviewer@test.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: ownerUserId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerUserId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "P", createdById: ownerUserId });
    await ctx.db.insert("projectCollaborators", { projectId, userId: ownerUserId, role: "owner", invitedById: ownerUserId, invitedAt: Date.now() });
    await ctx.db.insert("projectCollaborators", { projectId, userId: reviewerUserId, role: "evaluator", blindMode: true, invitedById: ownerUserId, invitedAt: Date.now() });
    return { ownerUserId, reviewerUserId, projectId };
  });
  return {
    ids,
    asOwner: t.withIdentity({ subject: `${ids.ownerUserId}|s`, tokenIdentifier: `test|${ids.ownerUserId}` }),
    asReviewer: t.withIdentity({ subject: `${ids.reviewerUserId}|s`, tokenIdentifier: `test|${ids.reviewerUserId}` }),
  };
}

describe("mapped CSV trajectory parsing", () => {
  test("parses RFC-style quoting and maps flat rows into normalized traces", () => {
    const result = parseCsvTraceBatch(csv, mapping);

    expect(result.summary).toMatchObject({ rows: 2, valid: 2, invalid: 0 });
    expect(result.summary.headers).toEqual([
      "run_id", "prompt", "response", "model", "provider", "harness", "case_key", "note",
    ]);
    expect(result.traces).toHaveLength(2);
    expect(result.traces[0]?.sourceId).toBe("r-1");
    expect(result.traces[0]?.trace.trace_id).toBe("csv-r-1");
    expect(result.traces[0]?.trace.harness.name).toBe("custom-agent");
    expect(result.traces[0]?.trace.steps.flatMap((step) =>
      step.type === "message" ? [step.message.content] : [],
    )).toEqual(["Summarize this, please", "First line\nSecond line"]);
    expect(result.traces[0]?.trace.metadata).toEqual({
      case_key: "case-1",
      note: "contains, comma",
    });
    expect(JSON.stringify(result.summary)).not.toContain("Summarize this");
    expect(JSON.stringify(result.summary)).not.toContain("Thanks for writing");
  });

  test("reports missing required cells by row without echoing their content", () => {
    const invalidCsv = "prompt,response\nhello,\n,answer\nvalid,answer";
    const result = parseCsvTraceBatch(invalidCsv, {
      inputColumn: "prompt",
      outputColumn: "response",
      metadataColumns: [],
    });
    expect(result.summary).toMatchObject({
      rows: 3,
      valid: 1,
      invalid: 2,
      missingInput: 1,
      missingOutput: 1,
      invalidRows: [2, 3],
    });
    expect(result.traces).toHaveLength(1);
  });

  test("rejects unknown mapping columns and unterminated quotes", () => {
    expect(() => parseCsvTraceBatch(csv, { ...mapping, inputColumn: "missing" })).toThrow(/unknown column.*missing/i);
    expect(() => parseCsvTraceBatch('prompt,response\n"broken,value', {
      inputColumn: "prompt",
      outputColumn: "response",
      metadataColumns: [],
    })).toThrow(/unterminated quoted field/i);
  });
});

describe("mapped CSV import through the trajectory spine", () => {
  test("authenticates before parsing untrusted file content", async () => {
    const t = convexTest(schema);
    const { ids } = await seed(t);
    await expect(t.action(api.csvImport.importMappedCsv, {
      projectId: ids.projectId,
      csv: "not,csv",
      mapping: { inputColumn: "input", outputColumn: "output", metadataColumns: [] },
    })).rejects.toThrow(/not authenticated/i);
  });

  test("runs the canonical CSV import → opaque review → SFT reuse loop", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asReviewer } = await seed(t);
    const oneRow = "run_id,prompt,response\nr-1,hello,world";
    expect(await asOwner.action(api.csvImport.importMappedCsv, {
      projectId: ids.projectId,
      csv: oneRow,
      mapping: { idColumn: "run_id", inputColumn: "prompt", outputColumn: "response", metadataColumns: [] },
    })).toMatchObject({ imported: 1, deduped: 0 });

    const sessions = await asReviewer.query(api.agentTraceReviewSessions.listMine, {});
    expect(sessions).toHaveLength(1);
    const token = sessions[0]?.token;
    if (!token) throw new Error("Missing opaque review token");
    expect(JSON.stringify(sessions)).not.toContain("agentTraceId");
    await asReviewer.mutation(api.agentTraceReviewSessions.addComment, {
      token,
      target: { kind: "trace" },
      comment: "Approved synthetic fixture.",
      label: "praise",
    });
    await asReviewer.mutation(api.agentTraceReviewSessions.setVerdict, { token, rating: "best" });

    const exported = await asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      source: "trajectory",
      format: "sft",
    });
    expect(exported.rowCount).toBe(1);
    expect(exported.manifest).toMatchObject({ format: "sft", source_units: 1, reviewers: 1 });
  });

  test("persists valid rows and deduplicates a repeated upload", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);

    const first = await asOwner.action(api.csvImport.importMappedCsv, {
      projectId: ids.projectId,
      csv,
      mapping: { ...mapping, metadataColumns: [...mapping.metadataColumns] },
    });
    expect(first).toMatchObject({ imported: 2, deduped: 0, summary: { valid: 2 } });

    const imports = await t.run(async (ctx) => await ctx.db.query("traceImports").collect());
    expect(imports).toHaveLength(2);
    expect(imports.every((row) => row.source === "csv" && row.rawPayloadStorageId !== undefined)).toBe(true);

    const second = await asOwner.action(api.csvImport.importMappedCsv, {
      projectId: ids.projectId,
      csv,
      mapping: { ...mapping, metadataColumns: [...mapping.metadataColumns] },
    });
    expect(second).toMatchObject({ imported: 0, deduped: 2 });
    expect(await t.run(async (ctx) => (await ctx.db.query("agentTraces").collect()).length)).toBe(2);
  });
});
