import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useOrg } from "@/contexts/OrgContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { friendlyError } from "@/lib/errors";
import {
  CloudDownload,
  ShieldAlert,
  ArrowLeft,
  Layers,
  ClipboardCheck,
} from "lucide-react";

type ImportSummary = FunctionReturnType<
  typeof api.gatewayImport.importGatewayLogs
>;

type MaterializeResult = FunctionReturnType<
  typeof api.gatewayImport.materializeImportedTraces
>;

export function GatewayImport() {
  const { org, orgId } = useOrg();
  const base = `/orgs/${org.slug}`;
  const projects = useQuery(api.projects.list, { orgId });
  const importLogs = useAction(api.gatewayImport.importGatewayLogs);

  const [projectId, setProjectId] = useState<string>("");
  const [jsonl, setJsonl] = useState("");
  const [sidecarJson, setSidecarJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setBusy(true);
    setError("");
    setSummary(null);
    try {
      const trimmedSidecar = sidecarJson.trim();
      const result = await importLogs({
        projectId: projectId as Id<"projects">,
        jsonl,
        ...(trimmedSidecar ? { sidecarJson: trimmedSidecar } : {}),
      });
      setSummary(result);
    } catch (err) {
      setError(friendlyError(err, "Import failed. Check the JSONL and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link
        to={`${base}/gateway-onboarding`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" aria-hidden="true" />
        Gateway onboarding
      </Link>

      <header className="mt-3">
        <div className="flex items-center gap-2">
          <CloudDownload aria-hidden="true" className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Import Gateway logs</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste exported Cloudflare AI Gateway logs (Logpush or API JSONL, one
          record per line) to register them as deduplicated trace imports.
        </p>
      </header>

      <Card className="mt-6 border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert aria-hidden="true" className="h-4 w-4 text-amber-600" />
            Data boundary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Blind Bench makes <strong className="text-foreground">no calls to
            Cloudflare</strong> — you export from your own gateway and paste it
            here. Import identity (a per-record dedup id) and the raw record are
            stored access-controlled, so imports can be re-parsed for eval sets.
          </p>
          <p>
            This page never renders your trace content back — only counts,
            model/provider names, and timestamps.
          </p>
        </CardContent>
      </Card>

      <form onSubmit={handleImport} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="gw-project">Project</Label>
          {/* native select dodges the base-ui Select callback gotchas */}
          <select
            id="gw-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            required
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="" disabled>
              {projects === undefined
                ? "Loading projects…"
                : projects.length === 0
                  ? "No projects — create one first"
                  : "Select a project"}
            </option>
            {projects?.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="gw-jsonl">Gateway logs (JSONL)</Label>
          <Textarea
            id="gw-jsonl"
            value={jsonl}
            onChange={(e) => setJsonl(e.target.value)}
            placeholder={'{"log_id":"...","model":"...","request":{...},"response":{...}}'}
            rows={12}
            required
            spellCheck={false}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            One JSON object per line. Up to 5,000 lines / 8&nbsp;MB per import —
            split larger exports into batches.
          </p>
        </div>

        <details className="rounded-lg border bg-muted/30 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Metadata sidecar (optional)
          </summary>
          <div className="mt-3 space-y-1.5">
            <Label htmlFor="gw-sidecar">Sidecar JSON</Label>
            <Textarea
              id="gw-sidecar"
              value={sidecarJson}
              onChange={(e) => setSidecarJson(e.target.value)}
              placeholder={'{ "<trace_id>": { "module": "...", "release": "..." } }'}
              rows={6}
              spellCheck={false}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Cloudflare keeps only 5 metadata keys per request. Paste a JSON
              object keyed by trace_id to restore the rest:{" "}
              <code className="text-foreground">
                {'{ "<trace_id>": { "module": "...", "release": "..." } }'}
              </code>
            </p>
          </div>
        </details>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy || !projectId || !jsonl.trim()}>
          {busy ? "Importing…" : "Import Gateway logs"}
        </Button>
      </form>

      {summary && <ImportSummaryCard summary={summary} />}

      {projectId && (
        <ScorecardConfigCard projectId={projectId as Id<"projects">} />
      )}

      {projectId && (
        <MaterializationCard
          projectId={projectId as Id<"projects">}
          scorecardHref={`${base}/scorecard`}
        />
      )}

      {projectId && (
        <p className="mt-6 text-sm">
          <Link
            to={`${base}/projects/${projectId}/history`}
            className="text-primary hover:underline"
          >
            View project import history →
          </Link>
        </p>
      )}
    </div>
  );
}

function ImportSummaryCard({ summary }: { summary: ImportSummary }) {
  const stats: { label: string; value: string }[] = [
    { label: "Imported", value: String(summary.imported) },
    { label: "Deduped", value: String(summary.deduped) },
    { label: "Parsed", value: String(summary.parsed) },
    { label: "Invalid lines", value: String(summary.invalid) },
    { label: "Missing request", value: String(summary.redactedRequest) },
    { label: "Missing response", value: String(summary.redactedResponse) },
  ];

  // "Log payloads" is off when nearly every imported row lands with no response
  // body — those outputs can never be scored. Amber, not red (color-blind rule).
  const processed = summary.imported + summary.deduped;
  const payloadsLikelyOff =
    processed > 0 && summary.redactedResponse >= processed * 0.9;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">Import summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {payloadsLikelyOff && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="flex items-start gap-2">
              <ShieldAlert
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
              />
              <div className="space-y-1">
                <p className="font-semibold">
                  This gateway isn’t storing payloads
                </p>
                <p className="text-muted-foreground">
                  Nearly every imported row has no response body, so these
                  outputs can’t be scored. Enable{" "}
                  <strong className="text-foreground">Log payloads</strong> in
                  Cloudflare (AI Gateway → your gateway → Settings), then
                  re-generate traffic and re-import.
                </p>
              </div>
            </div>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label}>
              <dt className="text-xs text-muted-foreground">{s.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>

        {summary.truncated && (
          <p className="text-xs text-amber-600">
            Import hit the per-batch line limit and stopped early — split the
            export and re-import the remainder.
          </p>
        )}
        {summary.invalidLines.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Invalid line numbers (first {summary.invalidLines.length}):{" "}
            {summary.invalidLines.join(", ")}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Meta label="Models" values={summary.models} />
          <Meta label="Providers" values={summary.providers} />
        </div>

        {(summary.earliest || summary.latest) && (
          <p className="text-xs text-muted-foreground">
            Window: {summary.earliest ?? "?"} → {summary.latest ?? "?"}
          </p>
        )}

        {summary.sidecar && (
          <p className="text-xs text-muted-foreground">
            Sidecar: {summary.sidecar.entries}{" "}
            {summary.sidecar.entries === 1 ? "entry" : "entries"},{" "}
            {summary.sidecar.matched} newly imported{" "}
            {summary.sidecar.matched === 1 ? "trace" : "traces"} enriched
            (previously imported duplicates keep their original metadata)
          </p>
        )}
      </CardContent>
    </Card>
  );
}

type ScorecardProjectConfig = NonNullable<
  FunctionReturnType<typeof api.scorecards.projectConfig>
>;
type ScorecardConfigValue = string | number | boolean | string[];
type ScorecardConfigMap = Record<string, Record<string, ScorecardConfigValue>>;

function splitList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function listValue(value: ScorecardConfigValue | undefined): string {
  return Array.isArray(value) ? value.join("\n") : "";
}

function ScorecardConfigCard({ projectId }: { projectId: Id<"projects"> }) {
  const remote = useQuery(api.scorecards.projectConfig, { projectId });
  const saveConfig = useMutation(api.scorecards.saveProjectConfig);
  const [scorerIds, setScorerIds] = useState<string[]>([]);
  const [scorerConfig, setScorerConfig] = useState<ScorecardConfigMap>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!remote) return;
    setScorerIds(remote.scorerIds);
    setScorerConfig(remote.scorerConfig as ScorecardConfigMap);
    setMessage("");
    setError("");
  }, [remote]);

  if (!remote) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Scorecard assignment</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Loading scorer configuration…
        </CardContent>
      </Card>
    );
  }

  function toggleScorer(id: string) {
    setScorerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function setField(
    scorerId: string,
    fieldKey: string,
    value: ScorecardConfigValue | undefined,
  ) {
    setScorerConfig((prev) => {
      const next: ScorecardConfigMap = { ...prev };
      const scorer = { ...(next[scorerId] ?? {}) };
      if (
        value === undefined ||
        (Array.isArray(value) && value.length === 0) ||
        value === ""
      ) {
        delete scorer[fieldKey];
      } else {
        scorer[fieldKey] = value;
      }
      if (Object.keys(scorer).length === 0) delete next[scorerId];
      else next[scorerId] = scorer;
      return next;
    });
  }

  async function handleSave() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const res = await saveConfig({
        projectId,
        config: { scorerIds, scorerConfig },
      });
      setScorerIds(res.scorerIds);
      setScorerConfig(res.scorerConfig as ScorecardConfigMap);
      setMessage("Saved. New materialized eval cases will use this assignment.");
    } catch (err) {
      setError(
        friendlyError(
          err,
          "Could not save scorecard assignment. Check the fields and try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const enabled = new Set(scorerIds);

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">Scorecard assignment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Choose which deterministic checks are stamped onto new eval cases when
          imported traces are materialized. Existing cases keep their snapshot.
        </p>
        <div className="space-y-3">
          {remote.catalog.map((scorer: ScorecardProjectConfig["catalog"][number]) => {
            const checked = enabled.has(scorer.id);
            return (
              <div key={scorer.id} className="rounded-lg border p-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleScorer(scorer.id)}
                    aria-label={`Enable ${scorer.label}`}
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{scorer.label}</p>
                      {scorer.hardFail && (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                          Hard fail
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {scorer.description}
                    </p>
                  </div>
                </div>

                {checked && scorer.configFields.length > 0 && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {scorer.configFields.map((field) => {
                      const current = scorerConfig[scorer.id]?.[field.key];
                      return (
                        <div key={field.key} className="space-y-1">
                          <Label className="text-xs">{field.label}</Label>
                          {field.type === "number" ? (
                            <Input
                              inputMode="decimal"
                              value={typeof current === "number" ? String(current) : ""}
                              placeholder="Optional"
                              onChange={(e) => {
                                const raw = e.target.value.trim();
                                setField(
                                  scorer.id,
                                  field.key,
                                  raw === "" ? undefined : Number(raw),
                                );
                              }}
                            />
                          ) : (
                            <Textarea
                              rows={3}
                              value={listValue(current)}
                              placeholder="One phrase per line"
                              onChange={(e) =>
                                setField(
                                  scorer.id,
                                  field.key,
                                  splitList(e.target.value),
                                )
                              }
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
        <Button type="button" onClick={handleSave} disabled={busy}>
          {busy ? "Saving…" : "Save scorecard assignment"}
        </Button>
      </CardContent>
    </Card>
  );
}

function MaterializationCard({
  projectId,
  scorecardHref,
}: {
  projectId: Id<"projects">;
  scorecardHref: string;
}) {
  const status = useQuery(api.gatewayImport.materializationStatus, {
    projectId,
  });
  const materialize = useAction(api.gatewayImport.materializeImportedTraces);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<MaterializeResult | null>(null);

  const total = status?.total;
  const materialized = status?.materialized;
  const fullyMaterialized =
    total !== undefined && materialized !== undefined && total === materialized;

  async function handleMaterialize() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await materialize({ projectId });
      setResult(res);
    } catch (err) {
      setError(
        friendlyError(
          err,
          "Could not materialize imported traces. Try again in a moment.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers aria-hidden="true" className="h-4 w-4 text-primary" />
          Materialize into eval cases
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status === undefined ? (
          <p className="text-muted-foreground">Loading materialization status…</p>
        ) : total === 0 ? (
          <p className="text-muted-foreground">
            No imported traces yet — import Gateway logs above, then materialize
            them into eval cases here.
          </p>
        ) : (
          <p>
            <span className="font-semibold tabular-nums">{materialized}</span> of{" "}
            <span className="font-semibold tabular-nums">{total}</span> imported
            traces materialized as eval cases.
          </p>
        )}

        {error && (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        )}

        <Button
          onClick={handleMaterialize}
          disabled={busy || !total || fullyMaterialized}
        >
          {busy
            ? "Materializing…"
            : fullyMaterialized
              ? "All traces materialized"
              : "Materialize into eval cases"}
        </Button>

        {result && (
          <dl className="grid grid-cols-2 gap-3 pt-1 sm:grid-cols-4">
            {[
              { label: "Materialized", value: result.materialized },
              { label: "Already done", value: result.alreadyMaterialized },
              { label: "Missing payload", value: result.missingPayload },
              { label: "Failed", value: result.failed },
            ].map((s) => (
              <div key={s.label}>
                <dt className="text-xs text-muted-foreground">{s.label}</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {s.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {materialized !== undefined && materialized > 0 && (
          <p className="pt-1">
            <Link
              to={scorecardHref}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ClipboardCheck aria-hidden="true" className="h-3.5 w-3.5" />
              Run the quality scorecard →
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Meta({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm">{values.length ? values.join(", ") : "—"}</p>
    </div>
  );
}
