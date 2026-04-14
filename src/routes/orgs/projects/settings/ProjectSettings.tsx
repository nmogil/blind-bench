import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { friendlyError } from "@/lib/errors";
import { ProjectSettingsNav } from "./ProjectSettingsNav";

export function ProjectSettings() {
  const { project, projectId, role } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const updateProject = useMutation(api.projects.update);
  const deleteProject = useMutation(api.projects.deleteProject);

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? "");
  }, [project.name, project.description]);

  if (role !== "owner") {
    return <Navigate to="/denied" replace />;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      await updateProject({
        projectId,
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(friendlyError(err, "Failed to save. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this prompt? This action cannot be undone.")) return;
    navigate(`/orgs/${orgSlug}`);
    try {
      await deleteProject({ projectId });
    } catch (err) {
      navigate(`/orgs/${orgSlug}/projects/${projectId}/settings`);
      setError(friendlyError(err, "Failed to delete prompt. Please try again."));
    }
  }

  return (
    <div className="flex">
      <ProjectSettingsNav />
      <div className="p-6 max-w-2xl flex-1">
      <h1 className="text-2xl font-bold">Prompt settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Manage prompt details.
      </p>

      <form onSubmit={handleSave} className="mt-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="project-name">Name</Label>
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="project-desc">Description</Label>
          <Input
            id="project-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this prompt is about"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-green-600">Settings saved.</p>}
        <Button type="submit" disabled={saving || !name.trim()}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </form>

      <Separator className="my-8" />

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={handleDelete}>
            Delete prompt
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            This will permanently delete the prompt and all its data.
          </p>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
