import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { friendlyError } from "@/lib/errors";
import {
  ClipboardCheck,
  ShieldAlert,
  ShieldCheck,
  Gauge,
  CheckCircle2,
  FileWarning,
  AlertTriangle,
  Play,
} from "lucide-react";

function formatTimestamp(ms: number | undefined): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "—";
  }
}

function formatScore(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : "—";
}

function formatPct(passed: number, cases: number): string {
  if (cases <= 0) return "—";
  return `${Math.round((passed / cases) * 100)}%`;
}

export function Scorecard() {
  const { org, orgId, role } = useOrg();
  const base = `/orgs/${org.slug}`;
  const canRun = role === "owner" || role === "admin";

  const latest = useQuery(api.scorecards.latest, { orgId });
  const creditStatus = useQuery(api.billing.getCreditStatus, { orgId });
  const startRun = useMutation(api.scorecards.start);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const inFlight =
    latest?.status === "pending" || latest?.status === "running";

  async function handleRun() {
    setBusy(true);
    setError("");
    try {
      await startRun({ orgId });
    } catch (err) {
      setError(
        friendlyError(
          err,
          "Could not start the scorecard run. Wait for any active run to finish, then try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const runButton = canRun ? (
    <div className="flex flex-col items-end gap-1">
      <Button
        onClick={handleRun}
        disabled={
          busy ||
          inFlight ||
          (creditStatus !== undefined &&
            creditStatus.remainingCredits < creditStatus.evalRunCost)
        }
      >
        <Play aria-hidden="true" className="h-4 w-4" />
        {inFlight ? "Scorecard running…" : busy ? "Starting…" : "Run scorecard"}
      </Button>
      {creditStatus !== undefined && (
        <p className="text-xs text-muted-foreground">
          {creditStatus.remainingCredits < creditStatus.evalRunCost
            ? "Out of eval credits — add credits in Billing to run the scorecard."
            : `Costs ${creditStatus.evalRunCost} eval credit · ${creditStatus.remainingCredits.toLocaleString()} remaining`}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  ) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardCheck aria-hidden="true" className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold">Quality scorecard</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Deterministic quality checks over the traces you imported from your
            AI Gateway — pass rate, hard-fails, and per-product breakdown.
          </p>
        </div>
        {runButton}
      </header>

      {latest === undefined ? (
        <LoadingState />
      ) : latest === null ? (
        <EmptyState base={base} canRun={canRun} />
      ) : inFlight ? (
        <RunningState cases={latest.summary?.cases} />
      ) : latest.status === "failed" ? (
        <FailedState
          startedAt={latest.startedAt}
          errorMessage={latest.errorMessage}
        />
      ) : (
        <CompletedScorecard latest={latest} />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-live="polite"
      aria-label="Loading scorecard"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-48 w-full" />
      <span className="sr-only">Loading scorecard…</span>
    </div>
  );
}

function EmptyState({ base, canRun }: { base: string; canRun: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">No scorecard yet</CardTitle>
        <CardDescription>
          The scorecard grades imported Gateway traffic. Set it up in three
          steps:
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ol className="space-y-3">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              1
            </span>
            <span className="text-muted-foreground">
              <Link
                to={`${base}/gateway-import`}
                className="font-medium text-primary hover:underline"
              >
                Import Gateway logs
              </Link>{" "}
              — paste your exported Cloudflare AI Gateway records.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              2
            </span>
            <span className="text-muted-foreground">
              Materialize those imports into eval cases from the{" "}
              <Link
                to={`${base}/gateway-import`}
                className="font-medium text-primary hover:underline"
              >
                Import Gateway logs
              </Link>{" "}
              page.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              3
            </span>
            <span className="text-muted-foreground">
              {canRun
                ? "Run the scorecard to grade every materialized case."
                : "Ask an org owner or admin to run the scorecard once cases exist."}
            </span>
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}

function RunningState({ cases }: { cases?: number }) {
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="flex items-center gap-3 py-6 text-sm">
        <Gauge aria-hidden="true" className="h-5 w-5 animate-pulse text-primary" />
        <div>
          <p className="font-medium">
            {cases && cases > 0
              ? `Scoring ${cases} case${cases === 1 ? "" : "s"}…`
              : "Scoring cases…"}
          </p>
          <p className="text-xs text-muted-foreground">
            This page updates automatically when the run finishes.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function FailedState({
  startedAt,
  errorMessage,
}: {
  startedAt: number;
  errorMessage?: string;
}) {
  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle
            aria-hidden="true"
            className="h-4 w-4 text-amber-600 dark:text-amber-400"
          />
          Scorecard run didn’t finish
        </CardTitle>
        <CardDescription>
          The scorecard run started {formatTimestamp(startedAt)} failed before
          producing results. Re-run the scorecard to try again.
        </CardDescription>
      </CardHeader>
      {errorMessage && (
        <CardContent className="text-sm text-muted-foreground">
          {errorMessage}
        </CardContent>
      )}
    </Card>
  );
}

type Latest = NonNullable<
  FunctionReturnType<typeof api.scorecards.latest>
>;

function CompletedScorecard({ latest }: { latest: Latest }) {
  const summary = latest.summary;
  const products = latest.products ?? [];
  const softFailures = latest.softFailuresByScorer ?? [];
  const hardFailFindings = latest.hardFailFindings ?? [];
  const blocked = (summary?.hardFailed ?? 0) > 0;

  // Every materialized case was skipped for want of a captured output — the
  // scorecard graded nothing. Make that the headline instead of an empty grid.
  const nothingScored =
    !!summary && summary.cases === 0 && summary.skippedNoOutput > 0;

  if (nothingScored) {
    return (
      <div className="space-y-8">
        <p className="text-xs text-muted-foreground">
          as of {formatTimestamp(latest.completedAt ?? latest.startedAt)}
        </p>
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileWarning
                aria-hidden="true"
                className="h-4 w-4 text-amber-600 dark:text-amber-400"
              />
              No cases could be scored
            </CardTitle>
            <CardDescription>
              All {summary.skippedNoOutput} materialized case
              {summary.skippedNoOutput === 1 ? "" : "s"} had no captured output
              to score — usually payload logging is off on the gateway. Enable{" "}
              <strong className="text-foreground">Log payloads</strong> in
              Cloudflare (AI Gateway → your gateway → Settings), re-generate
              traffic, and re-import.
            </CardDescription>
          </CardHeader>
        </Card>
        <Separator />
        <p className="text-xs text-muted-foreground">
          This surface shows only case IDs, product labels, scorer keys, and
          aggregate counts — never prompts, model outputs, or scorer reasons.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <p className="text-xs text-muted-foreground">
        as of {formatTimestamp(latest.completedAt ?? latest.startedAt)}
      </p>

      {/* Promotion gate banner — amber (blocked) / blue-purple (clear); no red/green */}
      {blocked ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 py-4 text-sm">
            <ShieldAlert
              aria-hidden="true"
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <div>
              <p className="font-semibold">Promotion blocked</p>
              <p className="text-muted-foreground">
                {summary?.hardFailed} hard-fail
                {summary?.hardFailed === 1 ? "" : "s"} must be resolved before
                this traffic can be promoted. A single hard-fail blocks
                promotion regardless of the mean quality score.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex items-start gap-3 py-4 text-sm">
            <ShieldCheck
              aria-hidden="true"
              className="mt-0.5 h-5 w-5 shrink-0 text-primary"
            />
            <div>
              <p className="font-semibold">Promotion gate clear</p>
              <p className="text-muted-foreground">
                No hard-fails in this run. The graded traffic clears the
                promotion gate.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Headline metrics */}
      {summary && (
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Headline metrics
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              icon={CheckCircle2}
              label="Pass rate"
              value={formatPct(summary.passed, summary.cases)}
              detail={`${summary.passed} / ${summary.cases} cases passing`}
            />
            <MetricCard
              icon={ShieldAlert}
              label="Hard-fails"
              value={String(summary.hardFailed)}
              detail={
                summary.hardFailed > 0
                  ? "Blocking — gates promotion"
                  : "None — gate is clear"
              }
              alert={summary.hardFailed > 0}
            />
            <MetricCard
              icon={Gauge}
              label="Mean score"
              value={formatScore(summary.meanScore)}
              detail="Mean across all scored cases"
            />
            <MetricCard
              icon={ClipboardCheck}
              label="Cases evaluated"
              value={String(summary.cases)}
              detail="Materialized eval cases graded"
            />
          </div>
          {summary.skippedNoOutput > 0 && (
            <div className="mt-3 space-y-2">
              <MetricCard
                icon={FileWarning}
                label="Skipped — no output"
                value={String(summary.skippedNoOutput)}
                detail="Imported traces with no captured output to grade"
              />
              <p className="text-xs text-muted-foreground">
                {summary.skippedNoOutput} case
                {summary.skippedNoOutput === 1 ? "" : "s"} had no captured
                output to score — usually payload logging is off on the gateway.
                Enable Log payloads in Cloudflare and re-import.
              </p>
            </div>
          )}
        </section>
      )}

      {/* Per-product breakdown */}
      {products.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Per-product breakdown
          </h2>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Cases</TableHead>
                  <TableHead className="text-right">Passed</TableHead>
                  <TableHead className="text-right">Hard-fails</TableHead>
                  <TableHead className="text-right">Mean score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.product}>
                    <TableCell className="font-medium">{p.product}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.cases}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.passed}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.hardFailed > 0 ? (
                        <span className="font-semibold text-amber-600 dark:text-amber-400">
                          {p.hardFailed}
                        </span>
                      ) : (
                        p.hardFailed
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatScore(p.meanScore)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* Soft failures by scorer */}
      {softFailures.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Soft failures by scorer
          </h2>
          <div className="flex flex-wrap gap-2">
            {softFailures.map((s) => (
              <Badge key={s.scorer} variant="secondary" className="gap-1.5">
                <code className="font-mono">{s.scorer}</code>
                <span className="tabular-nums">{s.count}</span>
              </Badge>
            ))}
          </div>
        </section>
      )}

      {/* Hard-fail findings */}
      {hardFailFindings.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Hard-fail findings
          </h2>
          <div className="divide-y rounded-lg border">
            {hardFailFindings.map((f) => (
              <div
                key={f.caseId}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <ShieldAlert
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                  />
                  <div>
                    <p className="font-mono text-sm">{f.caseId}</p>
                    <p className="text-xs text-muted-foreground">{f.product}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {f.scorers.map((scorer) => (
                    <Badge key={scorer} variant="outline" className="gap-1">
                      <code className="font-mono">{scorer}</code>
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <Separator />
      <p className="text-xs text-muted-foreground">
        This surface shows only case IDs, product labels, scorer keys, and
        aggregate counts — never prompts, model outputs, or scorer reasons.
      </p>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  alert,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
  detail: string;
  alert?: boolean;
}) {
  return (
    <Card className={alert ? "border-amber-500/40 bg-amber-500/5" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon
            aria-hidden={true}
            className={`h-4 w-4 ${alert ? "text-amber-600 dark:text-amber-400" : ""}`}
          />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}
