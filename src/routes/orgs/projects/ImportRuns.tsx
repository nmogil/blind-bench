import { useMemo, useState } from "react";
import { useAction } from "convex/react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  parseCsvRows,
  type CsvTraceMapping,
} from "@/lib/evals/csvTrace.core";
import {
  Braces,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Route,
  ShieldAlert,
  Upload,
} from "lucide-react";

type ImportSource = "paired" | "csv" | "otlp" | "pi" | "claude_code";
type CsvResult = FunctionReturnType<typeof api.csvImport.importMappedCsv>;
type OtlpResult = FunctionReturnType<typeof api.otlpFileImport.importOtlpJson>;
type PiResult = FunctionReturnType<typeof api.piImport.importPiSession>;
type ClaudeResult = FunctionReturnType<typeof api.claudeCodeImport.importClaudeCodeSession>;
type ImportResult = CsvResult | OtlpResult | PiResult | ClaudeResult;

type MappingField = Exclude<keyof CsvTraceMapping, "metadataColumns">;

const MAX_BYTES = 8 * 1024 * 1024;
const PAIRED_TEMPLATE = [
  "case_id,context,candidate_a,candidate_b,candidate_a_model,candidate_b_model,segment,privacy_class",
  'case-1,"Shared prompt or prior conversation","First completed attempt","Second completed attempt",model-a,model-b,demo,internal',
].join("\n");

const SOURCES = [
  {
    id: "paired",
    title: "Paired comparison",
    description: "Upload 2 completed attempts for every shared context and start a blind review.",
    accept: ".csv,text/csv",
    icon: FileSpreadsheet,
  },
  {
    id: "csv",
    title: "CSV",
    description: "Map flat prompt/output or interaction rows from any platform.",
    accept: ".csv,text/csv",
    icon: FileSpreadsheet,
  },
  {
    id: "otlp",
    title: "OpenTelemetry",
    description: "Upload captured OTLP/HTTP GenAI JSON from a tracing platform.",
    accept: ".json,application/json",
    icon: Route,
  },
  {
    id: "pi",
    title: "Pi session",
    description: "Import one saved Pi coding-agent session JSONL trajectory.",
    accept: ".jsonl,application/x-ndjson",
    icon: Braces,
  },
  {
    id: "claude_code",
    title: "Claude Code",
    description: "Import one Claude Code session transcript JSONL trajectory.",
    accept: ".jsonl,application/x-ndjson",
    icon: Braces,
  },
] as const satisfies ReadonlyArray<{
  readonly id: ImportSource;
  readonly title: string;
  readonly description: string;
  readonly accept: string;
  readonly icon: typeof FileSpreadsheet;
}>;

const MAPPING_FIELDS: ReadonlyArray<{
  readonly key: MappingField;
  readonly label: string;
  readonly required?: boolean;
}> = [
  { key: "inputColumn", label: "Input / prompt", required: true },
  { key: "outputColumn", label: "Output / response", required: true },
  { key: "idColumn", label: "Stable row / trace ID" },
  { key: "systemColumn", label: "System message" },
  { key: "timestampColumn", label: "Timestamp" },
  { key: "modelColumn", label: "Model" },
  { key: "providerColumn", label: "Provider" },
  { key: "harnessColumn", label: "Harness / agent" },
  { key: "productColumn", label: "Product" },
  { key: "moduleColumn", label: "Module" },
  { key: "environmentColumn", label: "Environment" },
  { key: "privacyClassColumn", label: "Privacy class" },
];

const FIELD_GUESSES: Record<MappingField, ReadonlyArray<string>> = {
  inputColumn: ["input", "prompt", "request", "question", "user_message"],
  outputColumn: ["output", "response", "completion", "answer", "assistant_message"],
  idColumn: ["id", "trace_id", "run_id", "request_id"],
  systemColumn: ["system", "system_message", "instructions"],
  timestampColumn: ["timestamp", "created_at", "time"],
  modelColumn: ["model", "model_id"],
  providerColumn: ["provider", "model_provider"],
  harnessColumn: ["harness", "agent", "sdk"],
  productColumn: ["product", "application", "service"],
  moduleColumn: ["module", "feature"],
  environmentColumn: ["environment", "env"],
  privacyClassColumn: ["privacy_class", "sensitivity"],
};

const PAIRED_HEADERS = ["case_id", "context", "candidate_a", "candidate_b"] as const;

function isPairedComparisonCsv(headers: ReadonlyArray<string>): boolean {
  const headerSet = new Set(headers);
  return PAIRED_HEADERS.every((header) => headerSet.has(header));
}

function guessMapping(headers: ReadonlyArray<string>): Partial<Record<MappingField, string>> {
  const lower = new Map(headers.map((header) => [header.toLowerCase(), header]));
  const mapping: Partial<Record<MappingField, string>> = {};
  for (const field of MAPPING_FIELDS) {
    const match = FIELD_GUESSES[field.key]
      .map((guess) => lower.get(guess))
      .find((value) => value !== undefined);
    if (match !== undefined) mapping[field.key] = match;
  }
  return mapping;
}

export function ImportRuns() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const importCsv = useAction(api.csvImport.importMappedCsv);
  const importPairedCsv = useAction(api.comparisonCampaigns.importPairedCsv);
  const importOtlp = useAction(api.otlpFileImport.importOtlpJson);
  const importPi = useAction(api.piImport.importPiSession);
  const importClaude = useAction(api.claudeCodeImport.importClaudeCodeSession);

  const [source, setSource] = useState<ImportSource>(
    searchParams.get("source") === "paired" ? "paired" : "csv",
  );
  const [fileName, setFileName] = useState("");
  const [comparisonName, setComparisonName] = useState("");
  const [payload, setPayload] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<ReadonlyArray<string>>([]);
  const [csvRows, setCsvRows] = useState(0);
  const [mapping, setMapping] = useState<Partial<Record<MappingField, string>>>({});
  const [metadataColumns, setMetadataColumns] = useState<ReadonlyArray<string>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  const selectedSource = SOURCES.find((item) => item.id === source) ?? SOURCES[0];
  const mappedColumns = useMemo(
    () => new Set(Object.values(mapping).filter((value) => value !== undefined)),
    [mapping],
  );
  const csvReady =
    source !== "csv" ||
    (mapping.inputColumn !== undefined && mapping.outputColumn !== undefined);
  const pairedReady =
    source !== "paired" ||
    (comparisonName.trim().length > 0 && isPairedComparisonCsv(csvHeaders));

  function resetFile(nextSource: ImportSource) {
    setSource(nextSource);
    setFileName("");
    setComparisonName("");
    setPayload("");
    setCsvHeaders([]);
    setCsvRows(0);
    setMapping({});
    setMetadataColumns([]);
    setError("");
    setResult(null);
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setResult(null);
    setError("");
    if (file.size > MAX_BYTES) {
      setError(`${file.name} is over the 8 MB upload limit. Split the file and retry.`);
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    setPayload(text);
    if (source === "csv" || source === "paired") {
      try {
        const rows = parseCsvRows(text);
        const headers = rows[0]?.map((header) => header.trim()) ?? [];
        if (headers.length === 0) throw new Error("CSV must contain a header row.");
        setCsvHeaders(headers);
        setCsvRows(Math.max(0, rows.length - 1));
        if (isPairedComparisonCsv(headers)) {
          setSource("paired");
          setMapping({});
          setMetadataColumns([]);
          setComparisonName((current) => current || file.name.replace(/\.csv$/i, ""));
        } else if (source === "paired") {
          setError("Paired comparison CSV requires case_id, context, candidate_a, and candidate_b columns.");
        } else {
          setMapping(guessMapping(headers));
        }
      } catch (cause: unknown) {
        setError(friendlyError(cause, "Could not read this CSV file."));
      }
    }
  }

  function downloadPairedTemplate() {
    const url = URL.createObjectURL(new Blob([PAIRED_TEMPLATE], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "blindbench-paired-comparison.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    if (!payload || !csvReady || !pairedReady || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (source === "paired") {
        const result = await importPairedCsv({
          projectId,
          name: comparisonName.trim(),
          csv: payload,
        });
        navigate(`/orgs/${orgSlug}/projects/${projectId}/comparisons/${result.campaignId}`);
      } else if (source === "csv") {
        const inputColumn = mapping.inputColumn;
        const outputColumn = mapping.outputColumn;
        if (!inputColumn || !outputColumn) {
          setError("Map both the input and output columns before importing.");
          return;
        }
        const csvMapping: CsvTraceMapping = {
          inputColumn,
          outputColumn,
          idColumn: mapping.idColumn,
          systemColumn: mapping.systemColumn,
          timestampColumn: mapping.timestampColumn,
          modelColumn: mapping.modelColumn,
          providerColumn: mapping.providerColumn,
          harnessColumn: mapping.harnessColumn,
          productColumn: mapping.productColumn,
          moduleColumn: mapping.moduleColumn,
          environmentColumn: mapping.environmentColumn,
          privacyClassColumn: mapping.privacyClassColumn,
          metadataColumns,
        };
        setResult(await importCsv({
          projectId,
          csv: payload,
          mapping: { ...csvMapping, metadataColumns: [...csvMapping.metadataColumns] },
        }));
      } else if (source === "otlp") {
        setResult(await importOtlp({ projectId, json: payload }));
      } else if (source === "pi") {
        setResult(await importPi({ projectId, jsonl: payload }));
      } else {
        setResult(await importClaude({ projectId, jsonl: payload }));
      }
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Import failed. Check the selected format and retry."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header>
        <div className="flex items-center gap-2">
          <Upload aria-hidden="true" className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Import runs and comparisons</h1>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Bring traces from the systems you already run. Blind Bench stores and
          reviews the resulting evidence; it does not execute your harness.
        </p>
      </header>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" role="list" aria-label="Import source">
        {SOURCES.map((item) => {
          const Icon = item.icon;
          const selected = source === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="listitem"
              onClick={() => resetFile(item.id)}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                selected ? "border-primary bg-primary/5" : "hover:border-primary/40 hover:bg-muted/40",
              )}
              aria-pressed={selected}
            >
              <Icon aria-hidden="true" className="h-4 w-4 text-primary" />
              <p className="mt-2 text-sm font-medium">{item.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
            </button>
          );
        })}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{selectedSource.title} file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {source === "paired" && (
            <div className="space-y-1.5">
              <Label htmlFor="comparison-name">Comparison name</Label>
              <Input
                id="comparison-name"
                value={comparisonName}
                onChange={(event) => setComparisonName(event.target.value)}
                placeholder="Alpha vs Beta — support replies"
                maxLength={120}
              />
              <p className="text-xs text-muted-foreground">
                Upload 2 completed attempts for every shared context. Required columns: <code>case_id</code>, <code>context</code>, <code>candidate_a</code>, and <code>candidate_b</code>.
              </p>
              <Button type="button" variant="ghost" size="sm" onClick={downloadPairedTemplate}>
                <Download aria-hidden="true" className="h-3.5 w-3.5" /> Download template
              </Button>
            </div>
          )}
          <label
            htmlFor="run-import-file"
            className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground"
          >
            <Upload aria-hidden="true" className="h-4 w-4" />
            {fileName || `Choose a ${selectedSource.title} file…`}
          </label>
          <input
            id="run-import-file"
            type="file"
            accept={selectedSource.accept}
            onChange={onFile}
            className="sr-only"
          />
          <p className="text-xs text-muted-foreground">
            Up to 8 MB. The raw file is retained access-controlled for re-parsing;
            import results and logs contain counts only.
          </p>

          {source === "csv" && csvHeaders.length > 0 && (
            <CsvMappingEditor
              headers={csvHeaders}
              rows={csvRows}
              mapping={mapping}
              metadataColumns={metadataColumns}
              mappedColumns={mappedColumns}
              onMappingChange={(field, column) =>
                setMapping((current) => ({ ...current, [field]: column || undefined }))
              }
              onMetadataChange={setMetadataColumns}
            />
          )}

          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

          <Button onClick={handleImport} disabled={busy || !payload || !csvReady || !pairedReady}>
            {busy ? "Importing…" : source === "paired" ? "Create comparison" : "Import runs"}
          </Button>
        </CardContent>
      </Card>

      {result && <ImportSummary result={result} tracesHref="../traces" />}

      <Card className="mt-6 border-amber-500/40 bg-amber-500/5">
        <CardContent className="flex gap-3 pt-6 text-sm text-muted-foreground">
          <ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p>
            Key-name redaction protects structured tool fields. Free-text prompts,
            outputs, and logs are not automatically scrubbed; upload only data your
            workspace is approved to store and review.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function CsvMappingEditor({
  headers,
  rows,
  mapping,
  metadataColumns,
  mappedColumns,
  onMappingChange,
  onMetadataChange,
}: {
  readonly headers: ReadonlyArray<string>;
  readonly rows: number;
  readonly mapping: Partial<Record<MappingField, string>>;
  readonly metadataColumns: ReadonlyArray<string>;
  readonly mappedColumns: ReadonlySet<string>;
  readonly onMappingChange: (field: MappingField, column: string) => void;
  readonly onMetadataChange: (columns: ReadonlyArray<string>) => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div>
        <p className="text-sm font-medium">Map CSV columns</p>
        <p className="text-xs text-muted-foreground">
          {rows.toLocaleString()} data rows · {headers.length} columns. Row content is not previewed.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {MAPPING_FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`csv-${field.key}`} className="text-xs">
              {field.label}{field.required ? " *" : ""}
            </Label>
            <select
              id={`csv-${field.key}`}
              value={mapping[field.key] ?? ""}
              onChange={(event) => onMappingChange(field.key, event.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            >
              <option value="">Not mapped</option>
              {headers.map((header) => <option key={header} value={header}>{header}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <Label className="text-xs">Additional metadata columns</Label>
        <div className="flex flex-wrap gap-2">
          {headers.filter((header) => !mappedColumns.has(header)).map((header) => {
            const selected = metadataColumns.includes(header);
            return (
              <label key={header} className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => onMetadataChange(
                    selected
                      ? metadataColumns.filter((column) => column !== header)
                      : [...metadataColumns, header],
                  )}
                />
                {header}
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ImportSummary({ result, tracesHref }: { readonly result: ImportResult; readonly tracesHref: string }) {
  const imported = "imported" in result ? result.imported : result.deduped ? 0 : 1;
  const deduped = typeof result.deduped === "number" ? result.deduped : result.deduped ? 1 : 0;
  const summary = result.summary as unknown as Record<string, unknown>;
  const numberAt = (key: string): number | undefined =>
    typeof summary[key] === "number" ? summary[key] : undefined;
  const stringsAt = (key: string): ReadonlyArray<string> =>
    Array.isArray(summary[key])
      ? (summary[key] as ReadonlyArray<unknown>).filter((value): value is string => typeof value === "string")
      : [];
  const metrics = [
    ["traces", numberAt("traces")],
    ["spans", numberAt("spans")],
    ["ignored spans", numberAt("ignoredSpans")],
    ["steps", numberAt("steps")],
    ["valid rows", numberAt("valid")],
    ["invalid rows/lines", numberAt("invalid")],
    ["missing inputs", numberAt("missingInput") ?? numberAt("requestMissing")],
    ["missing outputs", numberAt("missingOutput") ?? numberAt("responseMissing")],
    ["active entries", numberAt("activeEntries")],
    ["branches excluded", numberAt("branchesExcluded")],
    ["compactions", numberAt("compactions")],
  ] as const;
  const metricText = metrics.flatMap(([label, value]) =>
    value === undefined ? [] : [`${value} ${label}`],
  );
  const models = stringsAt("models");
  const harnesses = stringsAt("harnesses");
  return (
    <Card className="mt-6 border-primary/30">
      <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-primary" />
            Import complete
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {imported} imported · {deduped} already present
            {metricText.length > 0 ? ` · ${metricText.join(" · ")}` : ""}
          </p>
          {(models.length > 0 || harnesses.length > 0) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {models.length > 0 ? `Models: ${models.join(", ")}` : ""}
              {models.length > 0 && harnesses.length > 0 ? " · " : ""}
              {harnesses.length > 0 ? `Harnesses: ${harnesses.join(", ")}` : ""}
            </p>
          )}
        </div>
        <Link to={tracesHref} className={buttonVariants({ size: "sm" })}>
          Review trajectories
        </Link>
      </CardContent>
    </Card>
  );
}
