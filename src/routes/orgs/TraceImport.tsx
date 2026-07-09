import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useOrg } from "@/contexts/OrgContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { friendlyError } from "@/lib/errors";
import { Route, ShieldAlert, Upload } from "lucide-react";

type ImportResult = FunctionReturnType<
  typeof api.claudeCodeImport.importClaudeCodeSession
>;

const MAX_MB = 8;

export function TraceImport() {
  const { org, orgId } = useOrg();
  const base = `/orgs/${org.slug}`;
  const projects = useQuery(api.projects.list, { orgId });
  const importSession = useAction(api.claudeCodeImport.importClaudeCodeSession);

  const [projectId, setProjectId] = useState<string>("");
  const [jsonl, setJsonl] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`Session is ${(file.size / 1024 / 1024).toFixed(1)} MB — over the ${MAX_MB} MB limit. Trim old turns and retry.`);
      return;
    }
    setError("");
    setFileName(file.name);
    setJsonl(await file.text());
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !jsonl.trim()) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await importSession({ projectId: projectId as Id<"projects">, jsonl }));
    } catch (err) {
      setError(friendlyError(err, "Import failed. Check that this is a Claude Code session .jsonl and retry."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header>
        <div className="flex items-center gap-2">
          <Route aria-hidden="true" className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Import an agent session</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a Claude Code session transcript (<code>~/.claude/projects/…/*.jsonl</code>)
          to review the agent’s trajectory — every step, tool call, and result —
          as an ordered trace.
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
            The raw transcript is stored access-controlled so the trace can be
            re-parsed. This page returns only a{" "}
            <strong className="text-foreground">summary</strong> — step counts,
            models, and time bounds — never your session content. Re-uploading
            the same session is idempotent.
          </p>
        </CardContent>
      </Card>

      <form onSubmit={handleImport} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="tr-project">Project</Label>
          <select
            id="tr-project"
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
          <Label htmlFor="tr-file">Session file (.jsonl)</Label>
          <label
            htmlFor="tr-file"
            className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-input px-3 py-6 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground"
          >
            <Upload aria-hidden="true" className="h-4 w-4" />
            {fileName || "Choose a Claude Code .jsonl session…"}
          </label>
          <input id="tr-file" type="file" accept=".jsonl,application/x-ndjson" onChange={onFile} className="sr-only" />
          <p className="text-xs text-muted-foreground">
            Up to {MAX_MB}&nbsp;MB. Or paste the transcript below.
          </p>
        </div>

        <details className="rounded-lg border bg-muted/30 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">Paste instead</summary>
          <div className="mt-3 space-y-1.5">
            <Label htmlFor="tr-jsonl">Session JSONL</Label>
            <Textarea
              id="tr-jsonl"
              value={jsonl}
              onChange={(e) => { setJsonl(e.target.value); setFileName(""); }}
              placeholder={'{"type":"user","message":{...}}\n{"type":"assistant","message":{...}}'}
              rows={10}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
        </details>

        {error && (
          <p className="text-sm text-destructive" role="alert">{error}</p>
        )}

        <Button type="submit" disabled={busy || !projectId || !jsonl.trim()}>
          {busy ? "Importing…" : "Import session"}
        </Button>
      </form>

      {result && (
        <ImportResultCard
          result={result}
          tracesHref={`${base}/projects/${projectId}/traces`}
          exportHref={`${base}/projects/${projectId}/export`}
        />
      )}
    </div>
  );
}

function ImportResultCard({
  result,
  tracesHref,
  exportHref,
}: {
  result: ImportResult;
  tracesHref: string;
  exportHref: string;
}) {
  const s = result.summary;
  const stats = [
    { label: "Steps", value: s.steps },
    { label: "Events", value: s.events },
    { label: "Merged messages", value: s.mergedMessages },
    { label: "Invalid lines", value: s.invalid },
    { label: "Dropped metadata", value: s.droppedMeta },
    { label: "Compactions", value: s.compactions },
  ];
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">
          {result.deduped ? "Already imported" : "Import summary"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {result.deduped && (
          <p className="text-muted-foreground">
            This session was already imported — no duplicate was created.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {stats.map((x) => (
            <div key={x.label}>
              <dt className="text-xs text-muted-foreground">{x.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{x.value}</dd>
            </div>
          ))}
        </dl>
        <div>
          <p className="text-xs text-muted-foreground">Models</p>
          <p className="text-sm">{s.models.length ? s.models.join(", ") : "—"}</p>
        </div>
        {(s.earliest || s.latest) && (
          <p className="text-xs text-muted-foreground">
            Window: {s.earliest ?? "?"} → {s.latest ?? "?"}
          </p>
        )}
        <div className="flex flex-col gap-1 pt-1">
          <Link to={tracesHref} className="text-primary hover:underline">
            1. Review imported traces (comment + verdict) →
          </Link>
          <Link to={exportHref} className="text-primary hover:underline">
            2. Export an SFT / DPO dataset + manifest →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
