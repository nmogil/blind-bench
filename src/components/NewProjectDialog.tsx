import { useState, useMemo } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { friendlyError } from "@/lib/errors";
import { detectVariables } from "@/lib/detectVariables";

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewProjectDialog({
  open,
  onOpenChange,
}: NewProjectDialogProps) {
  const { org, orgId } = useOrg();
  const navigate = useNavigate();
  const createProject = useMutation(api.projects.create);
  const createWithPrompt = useMutation(api.projects.createWithPrompt);

  const [step, setStep] = useState<"info" | "prompt">("info");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [seedSample, setSeedSample] = useState(true);
  const [promptText, setPromptText] = useState("");
  const [varDefaults, setVarDefaults] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const detectedVars = useMemo(
    () => detectVariables(promptText),
    [promptText],
  );

  function resetState() {
    setStep("info");
    setName("");
    setDescription("");
    setSeedSample(true);
    setPromptText("");
    setVarDefaults({});
    setError("");
  }

  async function handleCreateBlank() {
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const projectId = await createProject({
        orgId,
        name: name.trim(),
        description: description.trim() || undefined,
        seedSample: seedSample || undefined,
      });
      onOpenChange(false);
      resetState();
      navigate(`/orgs/${org.slug}/projects/${projectId}`);
    } catch (err) {
      setError(friendlyError(err, "Failed to create project."));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateWithPrompt() {
    if (!name.trim() || !promptText.trim()) return;
    setSaving(true);
    setError("");
    try {
      const result = await createWithPrompt({
        orgId,
        name: name.trim(),
        description: description.trim() || undefined,
        promptText: promptText.trim(),
        detectedVariables: detectedVars.map((v) => ({
          name: v,
          defaultValue: varDefaults[v] || undefined,
        })),
      });
      onOpenChange(false);
      resetState();
      navigate(
        `/orgs/${org.slug}/projects/${result.projectId}/versions/${result.versionId}`,
      );
    } catch (err) {
      setError(friendlyError(err, "Failed to create project."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) resetState(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "info" ? "New project" : "Paste your prompt"}
          </DialogTitle>
        </DialogHeader>

        {step === "info" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My prompt project"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-desc">Description (optional)</Label>
              <Input
                id="project-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this project is about"
              />
            </div>
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={seedSample}
                  onCheckedChange={(checked) => setSeedSample(!!checked)}
                />
                <span className="text-sm">Start with a sample project</span>
              </label>
              <p className="mt-1 ml-6 text-xs text-muted-foreground">
                Includes a sample prompt, variable, and test case so you can try
                the full workflow immediately.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving || !name.trim()}
                  onClick={() => { setSeedSample(false); setStep("prompt"); }}
                >
                  Paste a prompt instead
                </Button>
                <Button
                  disabled={saving || !name.trim()}
                  onClick={handleCreateBlank}
                >
                  {saving ? "Creating..." : "Create"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Paste an existing prompt to get started fast. Use{" "}
              <code className="text-xs bg-muted px-1 rounded">{"{{variable}}"}</code>{" "}
              syntax for dynamic values.
            </p>

            <Textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder={"Translate the following into {{language}}:\n\n{{text}}"}
              className="min-h-[160px] font-mono text-sm"
              autoFocus
            />

            {detectedVars.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs">
                  Detected variables ({detectedVars.length})
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {detectedVars.map((v) => (
                    <span
                      key={v}
                      className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium"
                    >
                      {`{{${v}}}`}
                    </span>
                  ))}
                </div>
                <div className="space-y-1.5 mt-2">
                  {detectedVars.map((v) => (
                    <div key={v} className="flex items-center gap-2">
                      <Label className="text-xs w-24 shrink-0 truncate">
                        {v}
                      </Label>
                      <Input
                        value={varDefaults[v] ?? ""}
                        onChange={(e) =>
                          setVarDefaults((prev) => ({ ...prev, [v]: e.target.value }))
                        }
                        placeholder="Default value (optional)"
                        className="h-7 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep("info")}
              >
                Back
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={handleCreateBlank}
                >
                  Skip, start blank
                </Button>
                <Button
                  disabled={saving || !promptText.trim()}
                  onClick={handleCreateWithPrompt}
                >
                  {saving ? "Creating..." : "Create and start editing"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
