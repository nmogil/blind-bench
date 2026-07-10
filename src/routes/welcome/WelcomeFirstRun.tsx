import { useState } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import { useReducedMotion, motion } from "motion/react";
import { ArrowRight, FileText, Sparkles, Upload } from "lucide-react";

import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
} from "@/components/ui/tabs";
import { friendlyError } from "@/lib/errors";
import Grainient from "@/components/Grainient";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

type PasteRole = "system" | "user";

export function WelcomeFirstRun() {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const createForImport = useMutation(api.projects.createForImport);
  const createFromPaste = useMutation(api.projects.createFromPaste);
  const cloneStarter = useMutation(api.projects.cloneStarter);

  const [content, setContent] = useState("");
  const [pasteRole, setPasteRole] = useState<PasteRole>("system");
  const [submitting, setSubmitting] = useState(false);
  const [pendingPath, setPendingPath] = useState<"import" | "paste" | "clone" | null>(null);
  const [error, setError] = useState("");

  function landIn(orgSlug: string, projectId: string, versionId: string | null) {
    if (versionId) {
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/versions/${versionId}`,
        { replace: true },
      );
    } else {
      navigate(`/orgs/${orgSlug}/projects/${projectId}`, { replace: true });
    }
  }

  async function handleImport() {
    if (submitting) return;
    setSubmitting(true);
    setPendingPath("import");
    setError("");
    try {
      const res = await createForImport({});
      navigate(`/orgs/${res.orgSlug}/projects/${res.projectId}/import`, {
        replace: true,
      });
    } catch (err) {
      setError(friendlyError(err, "Couldn't create your import workspace."));
      setSubmitting(false);
      setPendingPath(null);
    }
  }

  async function handlePaste(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || submitting) return;
    setSubmitting(true);
    setPendingPath("paste");
    setError("");
    try {
      const res = await createFromPaste({ content, role: pasteRole });
      landIn(res.orgSlug, res.projectId, res.versionId);
    } catch (err) {
      setError(friendlyError(err, "Couldn't create your project."));
      setSubmitting(false);
      setPendingPath(null);
    }
  }

  async function handleClone() {
    if (submitting) return;
    setSubmitting(true);
    setPendingPath("clone");
    setError("");
    try {
      const res = await cloneStarter({});
      landIn(res.orgSlug, res.projectId, res.versionId);
    } catch (err) {
      setError(friendlyError(err, "Couldn't load the example project."));
      setSubmitting(false);
      setPendingPath(null);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-neutral-950 p-4">
      {reduceMotion ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(100deg,#94a3b8_0%,#5227FF_55%,#000000_100%)]"
        />
      ) : (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <Grainient
            color1="#94a3b8"
            color2="#5227FF"
            color3="#000000"
            timeSpeed={0.25}
            colorBalance={0.0}
            warpStrength={1.0}
            warpFrequency={5.0}
            warpSpeed={2.0}
            warpAmplitude={50.0}
            blendAngle={0.0}
            blendSoftness={0.05}
            rotationAmount={500.0}
            noiseScale={2.0}
            grainAmount={0.1}
            grainScale={2.0}
            grainAnimated={false}
            contrast={1.5}
            gamma={1.0}
            saturation={1.0}
            centerX={0.0}
            centerY={0.0}
            zoom={0.9}
          />
        </div>
      )}

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
        className="relative z-10 w-full max-w-xl"
      >
        <div className="rounded-xl border border-white/10 bg-background/90 p-8 shadow-2xl backdrop-blur-xl">
          <div className="space-y-1.5 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">
              Bring in completed AI runs
            </h1>
            <p className="text-sm text-muted-foreground">
              Upload traces from the systems you already run, then send them for blind expert review.
            </p>
          </div>

          <Tabs defaultValue="import" className="mt-6">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="import" className="gap-2">
                <Upload className="h-3.5 w-3.5" />
                Import runs
              </TabsTrigger>
              <TabsTrigger value="paste" className="gap-2">
                <FileText className="h-3.5 w-3.5" />
                Prompt playground
              </TabsTrigger>
              <TabsTrigger value="example" className="gap-2">
                <Sparkles className="h-3.5 w-3.5" />
                Example
              </TabsTrigger>
            </TabsList>

            <TabsPanel value="import" className="space-y-4 pt-4">
              <div className="space-y-3 rounded-md border bg-muted/30 p-4 text-xs">
                <p className="font-medium">Start with real behavior, not another runtime</p>
                <p className="text-muted-foreground">
                  Upload mapped CSV, OpenTelemetry GenAI JSON, or a saved Pi or Claude Code session. Blind Bench normalizes the evidence and never runs your harness.
                </p>
                <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                  <span className="rounded border bg-background px-2 py-1">CSV</span>
                  <span className="rounded border bg-background px-2 py-1">OpenTelemetry</span>
                  <span className="rounded border bg-background px-2 py-1">Pi</span>
                  <span className="rounded border bg-background px-2 py-1">Claude Code</span>
                </div>
              </div>
              <Button onClick={handleImport} className="w-full" disabled={submitting}>
                {pendingPath === "import" ? "Creating workspace…" : "Import completed runs"}
                {pendingPath !== "import" && <ArrowRight className="ml-1.5 h-3.5 w-3.5" />}
              </Button>
            </TabsPanel>

            <TabsPanel value="paste" className="space-y-4 pt-4">
              <form onSubmit={handlePaste} className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Paste your prompt</Label>
                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={
                      pasteRole === "system"
                        ? "You are a helpful assistant that…"
                        : "Summarize the following article in 3 bullets:\n\n{{article}}"
                    }
                    rows={9}
                    className="font-mono text-xs"
                    autoFocus
                    disabled={submitting}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Role</Label>
                  <div className="flex rounded-md border overflow-hidden w-fit">
                    {(["system", "user"] as PasteRole[]).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setPasteRole(r)}
                        disabled={submitting}
                        className={cn(
                          "px-3 py-1.5 text-xs font-medium transition-colors",
                          pasteRole === r
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {r === "system" ? "System message" : "User message"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {pasteRole === "system"
                      ? "Persistent instructions sent at the top of every agent run."
                      : "The turn the model responds to. Use {{name}} for variables."}
                  </p>
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitting || !content.trim()}
                >
                  {pendingPath === "paste" ? "Creating…" : "Create project"}
                  {pendingPath !== "paste" && (
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  )}
                </Button>
              </form>
            </TabsPanel>

            <TabsPanel value="example" className="space-y-4 pt-4">
              <div className="space-y-2 rounded-md border bg-muted/30 p-4 text-xs">
                <p className="font-medium">Blind-review walkthrough</p>
                <p className="text-muted-foreground">
                  A mutable sample of the original prompt playground. Use it to explore prompt/model output review without making it your core workflow.
                </p>
              </div>
              <Button
                onClick={handleClone}
                className="w-full"
                disabled={submitting}
              >
                {pendingPath === "clone" ? "Loading…" : "Load example project"}
                {pendingPath !== "clone" && (
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                )}
              </Button>
            </TabsPanel>
          </Tabs>

          {error && (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      </motion.div>
    </div>
  );
}
