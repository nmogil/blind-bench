import { useState } from "react";
import { useAction } from "convex/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, Upload } from "lucide-react";

import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";

const MAX_BYTES = 8 * 1024 * 1024;
const TEMPLATE = [
  "case_id,context,candidate_a,candidate_b,candidate_a_model,candidate_b_model,segment,privacy_class",
  'case-1,"Customer message and prior context","First possible reply","Second possible reply",model-a,model-b,scheduling,internal',
].join("\n");

export function ComparisonCampaignNew() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const importCsv = useAction(api.comparisonCampaigns.importPairedCsv);
  const [name, setName] = useState("");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `/orgs/${orgSlug}/projects/${projectId}`;

  async function selectFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(`${file.name} is over the 8 MB limit. Split it and try again.`);
      return;
    }
    setError("");
    setFileName(file.name);
    setCsv(await file.text());
    if (!name) setName(file.name.replace(/\.csv$/i, ""));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !csv || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await importCsv({ projectId, name: name.trim(), csv });
      navigate(`${base}/comparisons/${result.campaignId}`);
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not import this comparison CSV."));
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "blindbench-paired-comparison.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link to={`${base}/evaluate`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Reviews
      </Link>
      <header className="mt-3">
        <h1 className="text-2xl font-bold">Create a blind comparison</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload two completed attempts for each shared context. Blind Bench runs nothing—it only presents and records the review.
        </p>
      </header>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">Paired CSV</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="comparison-name">Comparison name</Label>
              <Input id="comparison-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="4o vs Luna — July SMS" maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="comparison-file">CSV file</Label>
              <label htmlFor="comparison-file" className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground">
                <Upload className="h-4 w-4" /> {fileName || "Choose paired responses…"}
              </label>
              <input id="comparison-file" type="file" accept=".csv,text/csv" onChange={selectFile} className="sr-only" />
              <p className="text-xs text-muted-foreground">
                Required: <code>case_id</code>, <code>context</code>, <code>candidate_a</code>, <code>candidate_b</code>. Optional model, harness, segment, environment, product, and privacy columns.
              </p>
              <Button type="button" variant="ghost" size="sm" onClick={downloadTemplate}>
                <Download className="h-3.5 w-3.5" /> Download template
              </Button>
            </div>
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-muted-foreground">
              Free-text context and replies are stored as supplied. Upload only data this workspace is approved to review and train on.
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <Button type="submit" disabled={busy || !name.trim() || !csv}>
              {busy ? "Importing…" : "Create comparison"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
