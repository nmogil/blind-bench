import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import { slugify } from "@/lib/slugify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { friendlyError } from "@/lib/errors";

export function OrgSettings() {
  const { org, orgId, role } = useOrg();

  if (role !== "owner") {
    return <Navigate to="/denied" replace />;
  }

  return <OrgSettingsForm orgId={orgId} org={org} />;
}

function OrgSettingsForm({
  orgId,
  org,
}: {
  orgId: ReturnType<typeof useOrg>["orgId"];
  org: ReturnType<typeof useOrg>["org"];
}) {
  const updateOrg = useMutation(api.organizations.updateOrg);
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setName(org.name);
    setSlug(org.slug);
  }, [org.name, org.slug]);

  const slugPreview = slugify(slug);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      await updateOrg({
        orgId,
        name: name.trim(),
        slug: slugPreview,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(friendlyError(err, "Failed to save settings. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Organization settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Manage your organization details.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="org-name">Name</Label>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="org-slug">URL slug</Label>
          <Input
            id="org-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
          {slugPreview && slugPreview !== slug && (
            <p className="text-xs text-muted-foreground">
              Will be saved as: <span className="font-mono">{slugPreview}</span>
            </p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && (
          <p className="text-sm text-green-600">Settings saved.</p>
        )}
        <Button type="submit" disabled={saving || !name.trim() || !slugPreview}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </form>

      <Separator className="my-8" />

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" disabled>
            Delete organization
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Organization deletion is not yet available.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
