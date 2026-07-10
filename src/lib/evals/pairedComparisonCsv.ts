/**
 * Strict paired-response CSV adapter for blind comparison campaigns.
 *
 * One valid row becomes two normalized traces with a byte-identical context
 * prefix. Candidate provenance stays on the traces and is never part of the
 * reviewer-facing summary returned by this module.
 */
import {
  normalizeEvalRecordV1,
  type AgentRunTrace,
  type PrivacyClass,
} from "./agentTrace.core";
import { CSV_IMPORT_MAX_ROWS, parseCsvRows } from "./csvTrace.core";

const REQUIRED_HEADERS = [
  "case_id",
  "context",
  "candidate_a",
  "candidate_b",
] as const;

/** One comparable case parsed from the paired CSV boundary. */
export interface PairedComparisonCase {
  readonly caseKey: string;
  readonly segment?: string;
  readonly candidateA: AgentRunTrace;
  readonly candidateB: AgentRunTrace;
}

/** Content-free paired CSV receipt safe for UI rendering and logs. */
export interface PairedComparisonCsvSummary {
  readonly rows: number;
  readonly valid: number;
  readonly invalid: number;
  readonly missingContext: number;
  readonly missingCandidateA: number;
  readonly missingCandidateB: number;
  readonly invalidRows: ReadonlyArray<number>;
  readonly segments: ReadonlyArray<string>;
}

/** Parsed comparison cases plus their content-free receipt. */
export interface PairedComparisonCsvBatch {
  readonly cases: ReadonlyArray<PairedComparisonCase>;
  readonly summary: PairedComparisonCsvSummary;
}

function parsePrivacyClass(value: string | undefined): PrivacyClass | undefined {
  switch (value) {
    case undefined:
    case "":
      return undefined;
    case "public":
    case "internal":
    case "confidential":
    case "pii":
    case "phi":
      return value;
    default:
      return undefined;
  }
}

function contentHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function makeCandidateTrace(input: {
  readonly caseKey: string;
  readonly side: "a" | "b";
  readonly context: string;
  readonly output: string;
  readonly model?: string;
  readonly harness?: string;
  readonly product?: string;
  readonly environment?: string;
  readonly privacyClass?: PrivacyClass;
  readonly segment?: string;
}): AgentRunTrace {
  const recordId = `comparison-${input.caseKey}-${input.side}-${contentHash([
    input.context,
    input.output,
    input.model ?? "",
    input.harness ?? "",
    input.product ?? "",
    input.environment ?? "",
    input.privacyClass ?? "",
    input.segment ?? "",
  ].join("\u0000"))}`;
  return normalizeEvalRecordV1({
    version: "1",
    id: recordId,
    model: input.model,
    input: {
      messages: [{ role: "user", content: input.context }],
    },
    output: { content: input.output },
    product: input.product ?? "paired-comparison",
    environment: input.environment,
    harness: {
      name: input.harness ?? "paired_csv",
      sdk: "paired-csv",
    },
    metadata: {
      comparison_case: input.caseKey,
      candidate_slot: input.side,
      ...(input.segment === undefined ? {} : { segment: input.segment }),
    },
    privacy_class: input.privacyClass,
  });
}

/** Parse strict paired CSV rows into comparable normalized candidate traces. */
export function parsePairedComparisonCsv(csv: string): PairedComparisonCsvBatch {
  const rows = parseCsvRows(csv);
  const headerRow = rows[0];
  if (!headerRow) throw new Error("CSV must contain a header row.");
  const headers = headerRow.map((header) => header.trim());
  if (new Set(headers).size !== headers.length) {
    throw new Error("CSV header names must be unique.");
  }
  const indexByHeader = new Map(headers.map((header, index) => [header, index]));
  for (const required of REQUIRED_HEADERS) {
    if (!indexByHeader.has(required)) {
      throw new Error(`Paired CSV requires a ${required} column.`);
    }
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > CSV_IMPORT_MAX_ROWS) {
    throw new Error(`Paired CSV has more than ${CSV_IMPORT_MAX_ROWS} data rows.`);
  }

  const valueAt = (row: ReadonlyArray<string>, header: string): string | undefined => {
    const index = indexByHeader.get(header);
    if (index === undefined) return undefined;
    const value = row[index]?.trim();
    return value ? value : undefined;
  };

  const cases: PairedComparisonCase[] = [];
  const invalidRows: number[] = [];
  const segments = new Set<string>();
  const seenCaseKeys = new Set<string>();
  let missingContext = 0;
  let missingCandidateA = 0;
  let missingCandidateB = 0;

  for (let index = 0; index < dataRows.length; index++) {
    const row = dataRows[index] ?? [];
    const lineNumber = index + 2;
    const caseKey = valueAt(row, "case_id");
    const context = valueAt(row, "context");
    const candidateA = valueAt(row, "candidate_a");
    const candidateB = valueAt(row, "candidate_b");
    const privacyRaw = valueAt(row, "privacy_class");
    const privacyClass = parsePrivacyClass(privacyRaw);

    if (context === undefined) missingContext++;
    if (candidateA === undefined) missingCandidateA++;
    if (candidateB === undefined) missingCandidateB++;
    if (
      caseKey === undefined ||
      context === undefined ||
      candidateA === undefined ||
      candidateB === undefined ||
      (privacyRaw !== undefined && privacyClass === undefined)
    ) {
      invalidRows.push(lineNumber);
      continue;
    }
    if (seenCaseKeys.has(caseKey)) {
      throw new Error(`CSV case_id values must be unique; duplicate at row ${lineNumber}.`);
    }
    seenCaseKeys.add(caseKey);

    const segment = valueAt(row, "segment");
    if (segment !== undefined) segments.add(segment);
    const shared = {
      caseKey,
      context,
      product: valueAt(row, "product"),
      environment: valueAt(row, "environment"),
      privacyClass,
      segment,
    };
    cases.push({
      caseKey,
      segment,
      candidateA: makeCandidateTrace({
        ...shared,
        side: "a",
        output: candidateA,
        model: valueAt(row, "candidate_a_model"),
        harness: valueAt(row, "candidate_a_harness"),
      }),
      candidateB: makeCandidateTrace({
        ...shared,
        side: "b",
        output: candidateB,
        model: valueAt(row, "candidate_b_model"),
        harness: valueAt(row, "candidate_b_harness"),
      }),
    });
  }

  return {
    cases,
    summary: {
      rows: dataRows.length,
      valid: cases.length,
      invalid: invalidRows.length,
      missingContext,
      missingCandidateA,
      missingCandidateB,
      invalidRows: invalidRows.slice(0, 100),
      segments: [...segments].sort(),
    },
  };
}
