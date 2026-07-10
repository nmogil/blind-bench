import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ClipboardCopy, Download, EyeOff, Lock } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { friendlyError } from "@/lib/errors";

const labels = [
  ["leftWins", "Candidate A"],
  ["rightWins", "Candidate B"],
  ["same", "Same"],
  ["neither", "Neither acceptable"],
  ["cannotJudge", "Cannot judge"],
] as const;

/** Owner results and contextual reuse for one paired blind review. */
export function ComparisonCampaignDetail() {
  const { projectId } = useProject();
  const { orgSlug, campaignId = "" } = useParams<{
    orgSlug: string;
    campaignId: string;
  }>();
  // SAFETY: Convex validates the route value as a table ID at the RPC boundary.
  const id = campaignId as Id<"comparisonCampaigns">;
  const campaign = useQuery(api.comparisonCampaigns.getOwnerCampaign, { campaignId: id });
  const openCampaign = useMutation(api.comparisonCampaigns.openCampaign);
  const closeCampaign = useMutation(api.comparisonCampaigns.closeCampaign);
  const generateExport = useAction(api.exports.generateExport);
  const downloadExport = useAction(api.exports.downloadExport);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reuseMessage, setReuseMessage] = useState("");
  const base = `/orgs/${orgSlug}/projects/${projectId}`;

  if (campaign === undefined) {
    return <div className="p-6 text-sm text-muted-foreground">Loading comparison…</div>;
  }
  const currentCampaign = campaign;
  const reviewUrl = `${window.location.origin}/review/campaign/${currentCampaign.shareToken}`;

  async function open() {
    setBusy(true);
    setError("");
    try {
      await openCampaign({ campaignId: id });
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not open this comparison."));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!window.confirm("Close this review? Reviewers will no longer be able to submit choices.")) return;
    setBusy(true);
    setError("");
    try {
      await closeCampaign({ campaignId: id });
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not close this comparison."));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    setError("");
    setReuseMessage("");
    try {
      const data = await generateExport({
        projectId,
        campaignId: id,
        source: "trajectory",
        format: "dpo",
      });
      if (data.rowCount === 0) {
        setReuseMessage(`No DPO rows were eligible. ${data.excludedCount} pairs were explicitly excluded for ties, disagreement, or comparability.`);
        return;
      }
      const { url } = await downloadExport({ exportId: data.exportId });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${currentCampaign.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-dpo.jsonl`;
      anchor.click();
      setReuseMessage(`${data.rowCount} DPO rows ready; ${data.excludedCount} excluded.`);
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not export this comparison."));
    } finally {
      setBusy(false);
    }
  }

  async function copyEvidence() {
    const summary = [
      currentCampaign.name,
      `${currentCampaign.results.judgments} judgments across ${currentCampaign.results.reviewedCases}/${currentCampaign.caseCount} pairs`,
      `Candidate A ${currentCampaign.results.leftWins} · Candidate B ${currentCampaign.results.rightWins} · Same ${currentCampaign.results.same}`,
      `Neither acceptable ${currentCampaign.results.neither} · Cannot judge ${currentCampaign.results.cannotJudge}`,
      `Agreement ${currentCampaign.results.agreementRate === null ? "not enough reviewers" : `${Math.round(currentCampaign.results.agreementRate * 100)}%`}`,
    ].join("\n");
    await navigator.clipboard.writeText(summary);
    setReuseMessage("Evidence summary copied.");
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link to={`${base}/evaluate`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Reviews
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{currentCampaign.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Compare attempts · {currentCampaign.caseCount} pairs · {currentCampaign.status}</p>
        </div>
        <div className="flex gap-2">
          {currentCampaign.status === "draft" && <Button onClick={open} disabled={busy}>Open for review</Button>}
          {currentCampaign.status === "open" && <Button variant="outline" onClick={close} disabled={busy}><Lock className="h-4 w-4" /> Close</Button>}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}

      <div className="mt-6 grid gap-4 lg:grid-cols-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Review link</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3"><EyeOff className="h-4 w-4 shrink-0 text-primary" /><code className="min-w-0 flex-1 truncate text-xs">{reviewUrl}</code><CopyButton text={reviewUrl} label="Copy review link" /></div>
            <p className="mt-2 text-xs text-muted-foreground">{currentCampaign.status === "draft" ? "Open the review before sharing this link." : "Reviewers enter a display name and receive five randomized comparisons at a time."}</p>
          </CardContent>
        </Card>
        <Metric title="Coverage" value={`${currentCampaign.results.reviewedCases}/${currentCampaign.caseCount}`} detail={`${currentCampaign.results.judgments} judgments`} />
        <Metric title="Agreement" value={currentCampaign.results.agreementRate === null ? "—" : `${Math.round(currentCampaign.results.agreementRate * 100)}%`} detail={currentCampaign.results.agreementRate === null ? "Needs 2+ reviewers per pair" : `${currentCampaign.results.agreementCases} pairs measured`} />
      </div>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Results</CardTitle></CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground"><span><strong className="text-foreground">Candidate A:</strong> {currentCampaign.candidateA.join(", ")}</span><span><strong className="text-foreground">Candidate B:</strong> {currentCampaign.candidateB.join(", ")}</span></div>
          <div className="grid gap-3 sm:grid-cols-5">{labels.map(([key, label]) => <ResultCount key={key} label={label} value={currentCampaign.results[key]} />)}</div>
          <p className="mt-4 text-xs text-muted-foreground">Source mapping is visible only here, after reviewers judge randomized Attempt 1 / Attempt 2 cards.</p>
        </CardContent>
      </Card>

      {currentCampaign.status === "closed" ? (
        <Card className="mt-4">
          <CardHeader><CardTitle className="text-base">Use this result</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void copyEvidence()}><ClipboardCopy className="h-4 w-4" /> Copy evidence summary</Button>
              <Button variant="outline" onClick={() => void download()} disabled={busy || currentCampaign.results.judgments === 0}><Download className="h-4 w-4" /> Export eligible DPO</Button>
            </div>
            <p className="text-xs text-muted-foreground">DPO includes only directional choices with a verified shared prefix. Ties, neither, cannot-judge, disagreement, and prefix mismatch are reported as exclusions.</p>
            {reuseMessage && <p className="text-sm text-muted-foreground" role="status">{reuseMessage}</p>}
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-4 border-dashed"><CardContent className="pt-6 text-sm text-muted-foreground">Close the review to unlock evidence and eligible preference export.</CardContent></Card>
      )}

      {currentCampaign.feedback.length > 0 && (
        <Card className="mt-4">
          <CardHeader><CardTitle className="text-base">Reviewer comments</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {currentCampaign.feedback.map((item, index) => <div key={`${item.caseKey}-${item.reviewerName}-${index}`} className="rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{item.caseKey} · {item.reviewerName}</span><span>{item.outcome}</span></div><p className="mt-2 whitespace-pre-wrap text-sm">{item.note}</p></div>)}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ title, value, detail }: { readonly title: string; readonly value: string; readonly detail: string }) {
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent><div className="text-3xl font-semibold">{value}</div><p className="mt-1 text-xs text-muted-foreground">{detail}</p></CardContent></Card>;
}

function ResultCount({ label, value }: { readonly label: string; readonly value: number }) {
  return <div className="rounded-lg border p-3"><div className="text-2xl font-semibold">{value}</div><div className="text-xs text-muted-foreground">{label}</div></div>;
}
