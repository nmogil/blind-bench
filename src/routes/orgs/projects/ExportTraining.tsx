import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Database, ShieldAlert, Download } from "lucide-react";

type ExportResult = FunctionReturnType<typeof api.exports.generateExport>;
type ExportRow = FunctionReturnType<typeof api.exports.listExports>[number];
type Manifest = ExportResult["manifest"];

type Source = "trajectory" | "output_preference";
type Format = "dpo" | "sft";

const SOURCE_LABELS: Record<Source, string> = {
  trajectory: "Agent trajectories",
  output_preference: "Prompt outputs",
};
const FORMAT_LABELS: Record<Format, string> = {
  dpo: "DPO",
  sft: "SFT",
};

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "—";
  }
}

export function ExportTraining() {
  const { projectId } = useProject();
  const generate = useAction(api.exports.generateExport);
  const download = useAction(api.exports.downloadExport);
  const exports = useQuery(api.exports.listExports, { projectId });

  const [source, setSource] = useState<Source>("trajectory");
  const [format, setFormat] = useState<Format>("dpo");
  const [allowSensitive, setAllowSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<
    (ExportResult & { source: Source; format: Format }) | null
  >(null);
  const [downloadError, setDownloadError] = useState("");

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    setDownloadError("");
    try {
      const res = await generate({ projectId, source, format, allowSensitive });
      setResult({ ...res, source, format });
    } catch (err) {
      setError(
        friendlyError(err, "Export failed. Adjust the source or format and try again."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function openDownload(exportId: Id<"trainingExports">) {
    try {
      const { url } = await download({ exportId });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      throw new Error(
        friendlyError(
          err,
          "Could not download this export. Generate a fresh one and try again.",
        ),
      );
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header>
        <div className="flex items-center gap-2">
          <Database aria-hidden="true" className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Export training data</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Turn blind evaluations into DPO / SFT fine-tuning datasets. Each export
          ships a manifest/report you can hand to Fireworks — counts, exclusions,
          sensitivity gate, and schema/version.
        </p>
      </header>

      <Card className="mt-6 border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert aria-hidden="true" className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            Data boundary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Exports are{" "}
            <strong className="text-foreground">anonymized by construction</strong> —
            no org names, emails, or API keys. Rows carry only resolved prompts,
            model outputs, blind labels, and aggregate counts.
          </p>
          <p>
            Rows marked prod-sensitive (confidential / PII / PHI) are{" "}
            <strong className="text-foreground">excluded</strong> unless you
            explicitly consent below.
          </p>
        </CardContent>
      </Card>

      <form onSubmit={handleGenerate} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ex-source">Source</Label>
          {/* native select dodges the base-ui Select callback gotchas */}
          <select
            id="ex-source"
            value={source}
            onChange={(e) => setSource(e.target.value as Source)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="trajectory">
              Agent trajectories (step-level preferences)
            </option>
            <option value="output_preference">
              Prompt outputs (best/weak ratings)
            </option>
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ex-format">Format</Label>
          <select
            id="ex-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as Format)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="dpo">DPO (preference pairs)</option>
            <option value="sft">SFT (best-only chat)</option>
            <option value="annotated" disabled>
              Annotated — coming soon
            </option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowSensitive}
              onChange={(e) => setAllowSensitive(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
            />
            <span>Include prod-sensitive rows (confidential/PII/PHI)</span>
          </label>
          {allowSensitive && (
            <p className="pl-6 text-xs text-amber-600 dark:text-amber-400">
              Only enable if you have consent to export sensitive data.
            </p>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy}>
          {busy ? "Generating…" : "Generate export"}
        </Button>
      </form>

      {result && (
        <ExportSummaryCard
          result={result}
          onDownload={openDownload}
          downloadError={downloadError}
          setDownloadError={setDownloadError}
        />
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Recent exports
        </h2>
        <RecentExports exports={exports} onDownload={openDownload} />
      </section>
    </div>
  );
}

function ExportSummaryCard({
  result,
  onDownload,
  downloadError,
  setDownloadError,
}: {
  result: ExportResult & { source: Source; format: Format };
  onDownload: (id: Id<"trainingExports">) => Promise<void>;
  downloadError: string;
  setDownloadError: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleDownload() {
    setBusy(true);
    setDownloadError("");
    try {
      await onDownload(result.exportId);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (result.rowCount === 0) {
    return (
      <Card className="mt-6 border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="text-base">No exportable rows yet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            No exportable rows for this source/format yet — e.g. trajectory DPO
            needs decided A/B matchups; output-preference DPO needs best+weak
            ratings on the same run.
          </p>
          {result.excludedCount > 0 && (
            <p>
              {result.excludedCount} row{result.excludedCount === 1 ? "" : "s"} were
              excluded by the data-boundary gate. Enable prod-sensitive rows above
              if you have consent to include them.
            </p>
          )}
          <ManifestReport manifest={result.manifest} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">Export ready</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-xs text-muted-foreground">Rows exported</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {result.rowCount} row{result.rowCount === 1 ? "" : "s"} exported
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Excluded</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {result.excludedCount} row{result.excludedCount === 1 ? "" : "s"}{" "}
              excluded by the data-boundary gate
            </dd>
          </div>
        </dl>

        <p className="text-xs text-muted-foreground">
          {SOURCE_LABELS[result.source]} · {FORMAT_LABELS[result.format]} · download
          link expires 1 hour after generation.
        </p>

        <ManifestReport manifest={result.manifest} />

        {downloadError && (
          <p className="text-sm text-destructive" role="alert">
            {downloadError}
          </p>
        )}

        <Button onClick={handleDownload} disabled={busy}>
          <Download aria-hidden="true" className="h-4 w-4" />
          {busy ? "Preparing…" : "Download JSONL"}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The Fireworks-handoff manifest/report shown under an export. Counts, the
 * sensitivity gate, schema/version, and human-readable notes on DPO comparability
 * and exclusions — enough to trust the export as a fine-tuning dataset. Raw JSON
 * is available in the collapsible for a full handoff.
 */
function ManifestReport({ manifest }: { manifest: Manifest }) {
  if (!manifest) return null;
  const reasons = Object.entries(manifest.excluded_by_reason) as Array<[
    string,
    number,
  ]>;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
          Fireworks-compatible
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          {manifest.schema} v{manifest.version} · rows shaped {manifest.fireworks.row_shape}
        </span>
      </p>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Source units</dt>
          <dd className="tabular-nums">{manifest.source_units}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Reviewers</dt>
          <dd className="tabular-nums">{manifest.reviewers}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Rows</dt>
          <dd className="tabular-nums">{manifest.row_count}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Excluded</dt>
          <dd className="tabular-nums">{manifest.excluded_count}</dd>
        </div>
      </dl>

      {reasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {reasons.map(([reason, count]) => (
            <span
              key={reason}
              className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {reason}: <span className="ml-1 tabular-nums">{count}</span>
            </span>
          ))}
        </div>
      )}

      {manifest.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
          {manifest.notes.map((note: string, i: number) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Raw manifest JSON</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-[11px]">
          {JSON.stringify(manifest, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function RecentExports({
  exports,
  onDownload,
}: {
  exports: ExportRow[] | undefined;
  onDownload: (id: Id<"trainingExports">) => Promise<void>;
}) {
  if (exports === undefined) {
    return (
      <div className="space-y-2" role="status" aria-label="Loading exports">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
        <span className="sr-only">Loading exports…</span>
      </div>
    );
  }

  if (exports.length === 0) {
    return <p className="text-sm text-muted-foreground">No exports yet.</p>;
  }

  return (
    <div className="divide-y rounded-lg border">
      {exports.map((row) => (
        <RecentExportRow key={row._id} row={row} onDownload={onDownload} />
      ))}
    </div>
  );
}

function RecentExportRow({
  row,
  onDownload,
}: {
  row: ExportRow;
  onDownload: (id: Id<"trainingExports">) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleDownload() {
    setBusy(true);
    setError("");
    try {
      await onDownload(row._id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const sourceLabel = SOURCE_LABELS[row.source as Source] ?? row.source;
  const formatLabel = FORMAT_LABELS[row.format as Format] ?? row.format.toUpperCase();
  const unavailable = row.availability !== "available";
  const availabilityLabel = row.availability === "revoked"
    ? "Revoked"
    : row.availability === "legacy_unapproved"
      ? "Unavailable"
      : row.availability === "expired"
        ? "Expired"
        : "Download";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-0.5 text-sm">
        <p className="font-medium">
          {sourceLabel} · {formatLabel} ·{" "}
          <span className="tabular-nums">
            {row.rowCount} row{row.rowCount === 1 ? "" : "s"}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {formatTimestamp(row.createdAt)}
        </p>
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={handleDownload}
        disabled={unavailable || busy}
        className={cn(unavailable && "text-muted-foreground")}
      >
        <Download aria-hidden="true" className="h-3.5 w-3.5" />
        {busy ? "Preparing…" : availabilityLabel}
      </Button>
    </div>
  );
}
