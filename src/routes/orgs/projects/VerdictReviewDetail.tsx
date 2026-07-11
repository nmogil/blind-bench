import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { friendlyError } from "@/lib/errors";
import { ArrowLeft, ClipboardCopy, Database, Download, EyeOff, Lock, MessageSquareText } from "lucide-react";

/** Owner/editor lifecycle and early results for one blind run review. */
export function VerdictReviewDetail() {
  const { projectId } = useProject();
  const { orgSlug, campaignId = "" } = useParams<{
    orgSlug: string;
    campaignId: string;
  }>();
  // SAFETY: Convex validates the route value as a table ID at the RPC boundary.
  const id = campaignId as Id<"verdictReviewCampaigns">;
  const campaign = useQuery(api.verdictReviewCampaigns.getOwnerCampaign, {
    campaignId: id,
  });
  const trainingApproval = useQuery(api.trainingApprovals.getForVerdictCampaign, { campaignId: id });
  const approveTraining = useAction(api.trainingApprovals.approveVerdictCampaign);
  const revokeTraining = useMutation(api.trainingApprovals.revoke);
  const openCampaign = useMutation(api.verdictReviewCampaigns.openCampaign);
  const closeCampaign = useMutation(api.verdictReviewCampaigns.closeCampaign);
  const promoteRuns = useMutation(api.verdictReviewCampaigns.promoteAcceptedRuns);
  const generateExport = useAction(api.exports.generateExport);
  const downloadExport = useAction(api.exports.downloadExport);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reuseMessage, setReuseMessage] = useState("");
  const base = `/orgs/${orgSlug}/projects/${projectId}`;

  if (campaign === undefined) {
    return <div className="p-6 text-sm text-muted-foreground">Loading review…</div>;
  }
  const currentCampaign = campaign;
  const reviewUrl = `${window.location.origin}/review/verdict/${currentCampaign.shareToken}`;

  async function open() {
    setBusy(true);
    setError("");
    try {
      await openCampaign({ campaignId: id });
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not open this review."));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!window.confirm("Close this review? Reviewers will no longer be able to submit verdicts.")) return;
    setBusy(true);
    setError("");
    try {
      await closeCampaign({ campaignId: id });
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not close this review."));
    } finally {
      setBusy(false);
    }
  }

  async function promote() {
    setBusy(true);
    setError("");
    setReuseMessage("");
    try {
      const result = await promoteRuns({ campaignId: id });
      setReuseMessage(
        `${result.added} added to the regression set · ${result.alreadyPresent} already present · ${result.excluded} excluded`,
      );
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not add these runs to the regression set."));
    } finally {
      setBusy(false);
    }
  }

  async function approveForTraining() {
    setBusy(true);
    setError("");
    setReuseMessage("");
    try {
      const result = await approveTraining({ campaignId: id });
      setReuseMessage(`Training approval granted for ${result.eligibleCount} eligible run${result.eligibleCount === 1 ? "" : "s"}; ${result.excludedCount} excluded.`);
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not grant training approval for this review."));
    } finally {
      setBusy(false);
    }
  }

  async function revokeTrainingApproval() {
    const approvalId = trainingApproval?.approval?.id;
    if (approvalId === undefined || !window.confirm("Revoke training approval? Future exports and downloads from this approval will be blocked.")) return;
    setBusy(true);
    setError("");
    try {
      await revokeTraining({ approvalId });
      setReuseMessage("Training approval revoked. Future exports and downloads are blocked.");
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not revoke this training approval."));
    } finally {
      setBusy(false);
    }
  }

  async function exportSft() {
    const approvalId = trainingApproval?.approval?.status === "active" ? trainingApproval.approval.id : undefined;
    if (approvalId === undefined) {
      setError("Grant a separate training approval before exporting SFT data.");
      return;
    }
    setBusy(true);
    setError("");
    setReuseMessage("");
    try {
      const result = await generateExport({
        projectId,
        verdictCampaignId: id,
        trainingApprovalId: approvalId,
        source: "trajectory",
        format: "sft",
      });
      if (result.rowCount === 0) {
        setReuseMessage(`No SFT rows were eligible. ${result.excludedCount} runs were explicitly excluded by review or data-boundary gates.`);
        return;
      }
      const { url, manifestUrl } = await downloadExport({ exportId: result.exportId });
      window.open(url, "_blank", "noopener,noreferrer");
      setReuseMessage(`${result.rowCount} approved SFT rows ready; ${result.excludedCount} excluded. Keep the manifest with the JSONL: ${manifestUrl}`);
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not export approved runs."));
    } finally {
      setBusy(false);
    }
  }

  async function copyEvidence() {
    const summary = [
      currentCampaign.name,
      `${currentCampaign.results.judgments} judgments from ${currentCampaign.results.reviewers} reviewers`,
      `${currentCampaign.results.best} strong · ${currentCampaign.results.acceptable} acceptable · ${currentCampaign.results.weak} weak`,
      `${currentCampaign.results.disagreementRuns} runs with disagreement`,
    ].join("\n");
    await navigator.clipboard.writeText(summary);
    setReuseMessage("Evidence summary copied.");
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link to={`${base}/evaluate`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" /> Reviews
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{currentCampaign.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Score runs · {currentCampaign.itemCount} runs · {currentCampaign.status}</p>
        </div>
        <div className="flex gap-2">
          {currentCampaign.status === "draft" && <Button onClick={open} disabled={busy}>Open for review</Button>}
          {currentCampaign.status === "open" && <Button variant="outline" onClick={close} disabled={busy}><Lock className="h-4 w-4" /> Close</Button>}
        </div>
      </div>
      {currentCampaign.instructions && <p className="mt-3 max-w-2xl text-sm text-muted-foreground">{currentCampaign.instructions}</p>}
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}

      <div className="mt-6 grid gap-4 lg:grid-cols-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Review link</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3">
              <EyeOff aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
              <code className="min-w-0 flex-1 truncate text-xs">{reviewUrl}</code>
              <CopyButton text={reviewUrl} label="Copy review link" />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {currentCampaign.status === "draft"
                ? "Open the review before sharing this link."
                : "Share this link in Slack or email. No Blind Bench account is required."}
            </p>
          </CardContent>
        </Card>
        <Metric title="Coverage" value={`${currentCampaign.results.reviewedRuns}/${currentCampaign.itemCount}`} detail={`${currentCampaign.results.judgments} judgments`} />
        <Metric title="Reviewers" value={String(currentCampaign.results.reviewers)} detail={currentCampaign.reviewerNames.join(", ") || "Awaiting reviewers"} />
      </div>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Verdicts</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-4">
            <ResultCount label="Best" value={currentCampaign.results.best} />
            <ResultCount label="Acceptable" value={currentCampaign.results.acceptable} />
            <ResultCount label="Weak" value={currentCampaign.results.weak} />
            <ResultCount label="Runs with disagreement" value={currentCampaign.results.disagreementRuns} />
          </div>
        </CardContent>
      </Card>

      {currentCampaign.status === "closed" ? (
        <Card className="mt-4">
          <CardHeader><CardTitle className="text-base">Use this result</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void copyEvidence()} disabled={busy}><ClipboardCopy className="h-4 w-4" /> Copy evidence summary</Button>
              <Button variant="outline" onClick={() => void promote()} disabled={busy || currentCampaign.results.judgments === 0}><Database className="h-4 w-4" /> Add approved runs to regression set</Button>
              {trainingApproval?.approval?.status === "active" ? (
                <Button variant="outline" onClick={() => void revokeTrainingApproval()} disabled={busy || !trainingApproval.canApprove}>Revoke training approval</Button>
              ) : (
                <Button variant="outline" onClick={() => void approveForTraining()} disabled={busy || currentCampaign.results.judgments === 0 || !trainingApproval?.canApprove}>Approve for training</Button>
              )}
              <Button variant="outline" onClick={() => void exportSft()} disabled={busy || trainingApproval?.approval?.status !== "active"}><Download className="h-4 w-4" /> Export approved SFT</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Review verdicts and objective quality eligibility do not grant training use. An owner must separately approve this closed result. SFT then includes only immutable reviewer-safe full-span evidence with a Strong verdict, and revocation blocks later export/download.
            </p>
            {reuseMessage && <p className="text-sm text-muted-foreground" role="status">{reuseMessage}</p>}
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-4 border-dashed">
          <CardContent className="pt-6 text-sm text-muted-foreground">Close the review to unlock evidence, regression, and eligible training-data actions.</CardContent>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Source mapping</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">Visible only to project owners and editors after reviewers judge blind.</p>
          {currentCampaign.runs.map((run) => (
            <div key={run.traceId} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-sm">
              <span>{[run.product, run.harness, run.model].filter(Boolean).join(" · ")}</span>
              <span className="text-xs text-muted-foreground">{run.judgments} judgments</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {currentCampaign.comments.length > 0 && (
        <Card className="mt-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MessageSquareText className="h-4 w-4" /> Reviewer comments</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {currentCampaign.comments.map((comment, index) => (
              <div key={`${comment.traceId}-${index}`} className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">{comment.reviewerName} · {comment.target.kind === "trace" ? "whole run" : `${comment.target.kind.replace("_", " ")} ${comment.target.stepIndex + 1}`}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm">{comment.comment}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ title, value, detail }: { readonly title: string; readonly value: string; readonly detail: string }) {
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent><div className="text-3xl font-semibold">{value}</div><p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p></CardContent></Card>;
}

function ResultCount({ label, value }: { readonly label: string; readonly value: number }) {
  return <div className="rounded-lg border p-3"><div className="text-2xl font-semibold">{value}</div><div className="text-xs text-muted-foreground">{label}</div></div>;
}
