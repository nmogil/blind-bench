import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Download, EyeOff, Lock } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { friendlyError } from "@/lib/errors";

const labels = [
  ["leftWins", "Candidate A"], ["rightWins", "Candidate B"], ["same", "Same"],
  ["neither", "Neither acceptable"], ["cannotJudge", "Cannot judge"],
] as const;

export function ComparisonCampaignDetail() {
  const { projectId } = useProject();
  const { orgSlug, campaignId } = useParams<{ orgSlug: string; campaignId: string }>();
  const id = campaignId as Id<"comparisonCampaigns">;
  const campaign = useQuery(api.comparisonCampaigns.getOwnerCampaign, { campaignId: id });
  const openCampaign = useMutation(api.comparisonCampaigns.openCampaign);
  const closeCampaign = useMutation(api.comparisonCampaigns.closeCampaign);
  const generateExport = useAction(api.exports.generateExport);
  const downloadExport = useAction(api.exports.downloadExport);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `/orgs/${orgSlug}/projects/${projectId}`;

  if (campaign === undefined) return <div className="p-6 text-sm text-muted-foreground">Loading comparison…</div>;
  const reviewUrl = `${window.location.origin}/review/campaign/${campaign.shareToken}`;
  const campaignName = campaign.name;

  async function open() {
    setBusy(true); setError("");
    try { await openCampaign({ campaignId: id }); }
    catch (cause: unknown) { setError(friendlyError(cause, "Could not open this comparison.")); }
    finally { setBusy(false); }
  }

  async function close() {
    if (!window.confirm("Close this campaign? Reviewers will no longer be able to submit choices.")) return;
    setBusy(true); setError("");
    try { await closeCampaign({ campaignId: id }); }
    catch (cause: unknown) { setError(friendlyError(cause, "Could not close this comparison.")); }
    finally { setBusy(false); }
  }

  async function download() {
    setBusy(true); setError("");
    try {
      const data = await generateExport({ projectId, campaignId: id, source: "trajectory", format: "dpo" });
      if (data.rowCount === 0) throw new Error("This campaign has no directional preferences to export yet.");
      const { url } = await downloadExport({ exportId: data.exportId });
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${campaignName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-dpo.jsonl`; anchor.click();
    } catch (cause: unknown) { setError(friendlyError(cause, "Could not export this comparison.")); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-5xl p-6">
    <Link to={`${base}/evaluate`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" /> Reviews</Link>
    <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold">{campaign.name}</h1><p className="mt-1 text-sm text-muted-foreground">{campaign.caseCount} paired cases · {campaign.status}</p></div>
      <div className="flex gap-2">{campaign.status === "draft" && <Button onClick={open} disabled={busy}>Open for review</Button>}{campaign.status === "open" && <Button variant="outline" onClick={close} disabled={busy}><Lock className="h-4 w-4" /> Close</Button>}<Button variant="outline" onClick={download} disabled={busy}><Download className="h-4 w-4" /> Export JSONL</Button></div>
    </div>
    {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
    <div className="mt-6 grid gap-4 lg:grid-cols-4">
      <Card className="lg:col-span-2"><CardHeader><CardTitle className="text-base">Review link</CardTitle></CardHeader><CardContent>
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3"><EyeOff className="h-4 w-4 shrink-0 text-primary" /><code className="min-w-0 flex-1 truncate text-xs">{reviewUrl}</code><CopyButton text={reviewUrl} label="Copy review link" /></div>
        <p className="mt-2 text-xs text-muted-foreground">Share in Slack. Reviewers enter a display name and get five randomized blind comparisons at a time.</p>
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Coverage</CardTitle></CardHeader><CardContent><div className="text-3xl font-semibold">{campaign.results.reviewedCases}/{campaign.caseCount}</div><p className="text-sm text-muted-foreground">cases · {campaign.results.judgments} judgments</p><p className="mt-2 truncate text-xs text-muted-foreground">{campaign.reviewerNames.join(", ") || "Awaiting reviewers"}</p></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Agreement</CardTitle></CardHeader><CardContent><div className="text-3xl font-semibold">{campaign.results.agreementRate === null ? "—" : `${Math.round(campaign.results.agreementRate * 100)}%`}</div><p className="text-sm text-muted-foreground">{campaign.results.agreementRate === null ? "Needs 2+ reviewers per case" : `majority agreement across ${campaign.results.agreementCases} cases`}</p></CardContent></Card>
    </div>
    <Card className="mt-4"><CardHeader><CardTitle className="text-base">Results</CardTitle></CardHeader><CardContent>
      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground"><span><strong className="text-foreground">Candidate A:</strong> {campaign.candidateA.join(", ")}</span><span><strong className="text-foreground">Candidate B:</strong> {campaign.candidateB.join(", ")}</span></div>
      <div className="grid gap-3 sm:grid-cols-5">{labels.map(([key, label]) => <div key={key} className="rounded-lg border p-3"><div className="text-2xl font-semibold">{campaign.results[key]}</div><div className="text-xs text-muted-foreground">{label}</div></div>)}</div>
      <p className="mt-4 text-xs text-muted-foreground">A/B is the canonical import order, independent of each reviewer’s randomized first/second presentation. JSONL includes only directional preferences; same, neither, and cannot judge remain in results but are excluded from training rows.</p>
    </CardContent></Card>
    {campaign.feedback.length > 0 && <Card className="mt-4"><CardHeader><CardTitle className="text-base">Reviewer notes</CardTitle></CardHeader><CardContent className="space-y-3">{campaign.feedback.map((item, index) => <div key={`${item.caseKey}-${item.reviewerName}-${index}`} className="rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{item.caseKey} · {item.reviewerName}</span><span>{item.outcome}</span></div><p className="mt-2 whitespace-pre-wrap text-sm">{item.note}</p></div>)}</CardContent></Card>}
  </div>;
}
