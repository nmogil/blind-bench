/**
 * Isomorphic mapped-CSV adapter. CSV is intentionally limited to one flat
 * model interaction per row; hierarchical agent sessions use OTLP or harness
 * JSONL importers instead.
 */
import {
  normalizeEvalRecordV1,
  type AgentRunTrace,
  type PrivacyClass,
} from "./agentTrace.core";

/** User-selected CSV column mapping. */
export interface CsvTraceMapping {
  readonly inputColumn: string;
  readonly outputColumn: string;
  readonly idColumn?: string;
  readonly systemColumn?: string;
  readonly timestampColumn?: string;
  readonly modelColumn?: string;
  readonly providerColumn?: string;
  readonly harnessColumn?: string;
  readonly productColumn?: string;
  readonly moduleColumn?: string;
  readonly environmentColumn?: string;
  readonly privacyClassColumn?: string;
  readonly metadataColumns: ReadonlyArray<string>;
}

/** One normalized CSV row and its stable source-scoped deduplication key. */
export interface CsvNormalizedTrace {
  readonly sourceId: string;
  readonly trace: AgentRunTrace;
}

/** Content-free parse/import preview safe for UI and operator logs. */
export interface CsvTraceSummary {
  readonly headers: ReadonlyArray<string>;
  readonly rows: number;
  readonly valid: number;
  readonly invalid: number;
  readonly missingInput: number;
  readonly missingOutput: number;
  readonly invalidRows: ReadonlyArray<number>;
  readonly models: ReadonlyArray<string>;
  readonly harnesses: ReadonlyArray<string>;
}

/** Parsed traces plus their management-safe summary. */
export interface CsvTraceBatch {
  readonly traces: ReadonlyArray<CsvNormalizedTrace>;
  readonly summary: CsvTraceSummary;
}

export const CSV_IMPORT_MAX_ROWS = 1_000;
const MAX_COLUMNS = 200;
const PRIVACY_CLASSES = new Set<PrivacyClass>([
  "public",
  "internal",
  "confidential",
  "pii",
  "phi",
]);

/** Parse RFC 4180-style CSV, including escaped quotes and quoted newlines. */
export function parseCsvRows(csv: string): ReadonlyArray<ReadonlyArray<string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    if (row.length > MAX_COLUMNS) {
      throw new Error(`CSV has more than ${MAX_COLUMNS} columns.`);
    }
    if (row.some((value) => value.length > 0)) rows.push(row);
    row = [];
    if (rows.length > CSV_IMPORT_MAX_ROWS + 1) {
      throw new Error(`CSV has more than ${CSV_IMPORT_MAX_ROWS} data rows.`);
    }
  };

  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (quoted) {
      if (char === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      if (csv[index + 1] === "\n") continue;
      pushRow();
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field.");
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

const optionalMappings = (mapping: CsvTraceMapping): ReadonlyArray<string> => [
  mapping.idColumn,
  mapping.systemColumn,
  mapping.timestampColumn,
  mapping.modelColumn,
  mapping.providerColumn,
  mapping.harnessColumn,
  mapping.productColumn,
  mapping.moduleColumn,
  mapping.environmentColumn,
  mapping.privacyClassColumn,
].flatMap((column) => (column === undefined ? [] : [column]));

/** Parse, validate, and normalize mapped CSV rows into trajectory records. */
export function parseCsvTraceBatch(
  csv: string,
  mapping: CsvTraceMapping,
): CsvTraceBatch {
  const rows = parseCsvRows(csv);
  const headerRow = rows[0];
  if (!headerRow) throw new Error("CSV must contain a header row.");
  const headers = headerRow.map((header) => header.trim());
  if (headers.some((header) => header.length === 0)) {
    throw new Error("CSV header names cannot be empty.");
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error("CSV header names must be unique.");
  }
  const indexByHeader = new Map(headers.map((header, index) => [header, index]));
  const mappedColumns = [
    mapping.inputColumn,
    mapping.outputColumn,
    ...optionalMappings(mapping),
    ...mapping.metadataColumns,
  ];
  for (const column of mappedColumns) {
    if (!indexByHeader.has(column)) {
      throw new Error(`CSV mapping references unknown column "${column}".`);
    }
  }

  const valueAt = (row: ReadonlyArray<string>, column: string | undefined): string | undefined => {
    if (column === undefined) return undefined;
    const index = indexByHeader.get(column);
    if (index === undefined) return undefined;
    const value = row[index];
    return value === undefined || value.length === 0 ? undefined : value;
  };

  const traces: CsvNormalizedTrace[] = [];
  const invalidRows: number[] = [];
  const models = new Set<string>();
  const harnesses = new Set<string>();
  let missingInput = 0;
  let missingOutput = 0;
  const dataRows = rows.slice(1);

  for (let index = 0; index < dataRows.length; index++) {
    const row = dataRows[index] ?? [];
    const input = valueAt(row, mapping.inputColumn);
    const output = valueAt(row, mapping.outputColumn);
    if (input === undefined || input.trim().length === 0) missingInput++;
    if (output === undefined || output.trim().length === 0) missingOutput++;
    if (
      input === undefined ||
      input.trim().length === 0 ||
      output === undefined ||
      output.trim().length === 0
    ) {
      invalidRows.push(index + 2);
      continue;
    }

    const sourceId = valueAt(row, mapping.idColumn);
    const model = valueAt(row, mapping.modelColumn);
    const provider = valueAt(row, mapping.providerColumn);
    const harness = valueAt(row, mapping.harnessColumn);
    const privacyRaw = valueAt(row, mapping.privacyClassColumn);
    const privacyClass =
      privacyRaw !== undefined && PRIVACY_CLASSES.has(privacyRaw as PrivacyClass)
        ? (privacyRaw as PrivacyClass)
        : undefined;
    if (privacyRaw !== undefined && privacyClass === undefined) {
      invalidRows.push(index + 2);
      continue;
    }

    const metadata: Record<string, unknown> = {};
    for (const column of mapping.metadataColumns) {
      const value = valueAt(row, column);
      if (value !== undefined) metadata[column] = value;
    }
    const messages = [
      ...(valueAt(row, mapping.systemColumn) === undefined
        ? []
        : [{ role: "system", content: valueAt(row, mapping.systemColumn) ?? "" }]),
      { role: "user", content: input },
    ];
    const nativeTrace = normalizeEvalRecordV1({
      version: "1",
      id: sourceId,
      timestamp: valueAt(row, mapping.timestampColumn),
      model,
      provider,
      input: { messages },
      output: { content: output },
      product: valueAt(row, mapping.productColumn),
      module: valueAt(row, mapping.moduleColumn),
      environment: valueAt(row, mapping.environmentColumn),
      harness: harness === undefined ? undefined : { name: harness, sdk: "csv" },
      metadata,
      privacy_class: privacyClass,
    });
    const derivedId = nativeTrace.trace_id.startsWith("native-")
      ? nativeTrace.trace_id.slice("native-".length)
      : nativeTrace.trace_id;
    const csvSourceId = sourceId ?? derivedId;
    const trace: AgentRunTrace = {
      ...nativeTrace,
      trace_id: `csv-${csvSourceId}`,
      run_id: csvSourceId,
      source_ids: { csv_row_id: csvSourceId },
      harness: harness === undefined
        ? { name: "csv_import", sdk: "csv" }
        : { name: harness, sdk: "csv" },
    };
    traces.push({ sourceId: csvSourceId, trace });
    if (model !== undefined) models.add(model);
    if (harness !== undefined) harnesses.add(harness);
  }

  return {
    traces,
    summary: {
      headers,
      rows: dataRows.length,
      valid: traces.length,
      invalid: invalidRows.length,
      missingInput,
      missingOutput,
      invalidRows: invalidRows.slice(0, 100),
      models: [...models],
      harnesses: [...harnesses],
    },
  };
}
