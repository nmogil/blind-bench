import type { HarborReviewerProjection } from "@/lib/evals/harborEvidence";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2, FileDiff, TerminalSquare } from "lucide-react";

function JsonBody({ value }: { readonly value: unknown }) {
  return (
    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function FullSpanReviewEvidence({ evidence }: { readonly evidence: HarborReviewerProjection }) {
  const verifierPassed = evidence.outcomes.verifier.status === "passed" &&
    evidence.verifierEvidence?.exitCode === 0 &&
    evidence.verifierEvidence.timedOut === false;
  return (
    <div className="space-y-6">
      {evidence.evidenceWarning && (
        <Card className="border-amber-500/40 bg-amber-500/5" role="alert">
          <CardContent className="flex gap-2 pt-0 text-sm">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
              <p className="font-medium">
                {evidence.runQualification === "fixture_only" ? "Fixture-only evidence" : "Evidence incomplete"}
              </p>
              <p className="text-muted-foreground">{evidence.evidenceWarning}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Task</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="whitespace-pre-wrap text-sm">{evidence.taskPrompt}</p>
          <p className="text-xs text-muted-foreground">
            {evidence.timing.durationMs.toLocaleString()} ms · {evidence.termination.status} · {evidence.termination.reason}
          </p>
        </CardContent>
      </Card>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Chronology</h2>
        <ol className="space-y-2">
          {evidence.events.map((event) => {
            const toolEvent = event.kind === "tool_call" || event.kind === "tool_result" || event.kind === "tool_error";
            return (
              <li key={event.sequence} className="rounded-lg border bg-card px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{event.sequence}</span>
                  <span className="font-medium">{event.kind.replace(/_/g, " ")}</span>
                  {event.toolName && <span className="font-mono text-xs text-muted-foreground">{event.toolName}</span>}
                  {event.callId && <span className="ml-auto font-mono text-xs text-muted-foreground">{event.callId}</span>}
                </div>
                {toolEvent ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">Show sanitized detail</summary>
                    <JsonBody value={event.arguments ?? event.result ?? event.error ?? event.status} />
                  </details>
                ) : event.content ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm">{event.content}</p>
                ) : event.reason ? (
                  <p className="mt-1 text-sm text-muted-foreground">{event.reason}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      <Card>
        <CardHeader><CardTitle className="text-base">Final output</CardTitle></CardHeader>
        <CardContent><p className="whitespace-pre-wrap text-sm">{evidence.finalOutput}</p></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Objective outcomes</CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
          {(["process", "verifier", "infrastructure"] as const).map((key) => (
            <div key={key} className="rounded-md border p-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">{key}</p>
              <p className="mt-1 font-medium">{evidence.outcomes[key].status}</p>
              {evidence.outcomes[key].summary && <p className="mt-1 text-xs text-muted-foreground">{evidence.outcomes[key].summary}</p>}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileDiff aria-hidden="true" className="h-4 w-4" />Workspace changes</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {evidence.changedFiles.length > 0 ? (
            <ul className="space-y-1 font-mono text-xs">
              {evidence.changedFiles.map((file, index) => <li key={`${index}-${file.path}`}>{file.status ? `${file.status} · ` : ""}{file.path}</li>)}
            </ul>
          ) : <p className="text-sm text-muted-foreground">The upload did not include a changed-files manifest.</p>}
          {evidence.patch ? <details><summary className="cursor-pointer text-sm font-medium">Show bounded patch{evidence.patchTruncated ? " (preview truncated; integrity hash covers the full artifact)" : ""}</summary><JsonBody value={evidence.patch} /></details> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><TerminalSquare aria-hidden="true" className="h-4 w-4" />Verifier evidence</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Evidence integrity: {evidence.integrity.status}
          </p>
          {evidence.verifierEvidence ? (
            <>
              <p className="text-sm font-medium">{evidence.verifierEvidence.commandSummary}</p>
              <p className="flex items-center gap-1 text-sm">
                {verifierPassed ? (
                  <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-primary" />
                ) : (
                  <AlertTriangle aria-hidden="true" className="h-4 w-4 text-amber-600" />
                )}
                {evidence.verifierEvidence.timedOut ? "Timed out" : `Exit ${evidence.verifierEvidence.exitCode ?? "not reported"}`}
              </p>
              {(evidence.verifierEvidence.stdout || evidence.verifierEvidence.stderr) && (
                <details><summary className="cursor-pointer text-sm text-muted-foreground">Show sanitized log summary{evidence.verifierEvidence.stdoutTruncated || evidence.verifierEvidence.stderrTruncated ? " (preview truncated)" : ""}</summary><JsonBody value={[evidence.verifierEvidence.stdout, evidence.verifierEvidence.stderr].filter(Boolean).join("\n")} /></details>
              )}
            </>
          ) : <p className="text-sm text-muted-foreground">The upload did not include verifier evidence.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
