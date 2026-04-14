import { useState, useMemo } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api";
import { slugify } from "@/lib/slugify";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Onboarding() {
  const navigate = useNavigate();
  const { signOut } = useAuthActions();
  const createOrg = useMutation(api.organizations.createOrg);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const slug = useMemo(() => slugify(name), [name]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !slug) return;

    setSaving(true);
    setError("");
    try {
      await createOrg({ name: name.trim(), slug });
      navigate(`/orgs/${slug}`);
    } catch (err) {
      setError(friendlyError(err, "Failed to create workspace. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Create your workspace</CardTitle>
          <p className="text-sm text-muted-foreground">
            A workspace holds your team's prompts, API keys, and members.
            You can rename it later.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="org-name">Organization name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Inc."
                autoFocus
              />
            </div>
            {slug && (
              <p className="text-sm text-muted-foreground">
                Your URL: <span className="font-mono">blindbench.dev/orgs/{slug}</span>
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              type="submit"
              className="w-full"
              disabled={saving || !name.trim() || !slug}
            >
              {saving ? "Creating..." : "Create"}
            </Button>
          </form>
          <div className="mt-4 text-center">
            <button
              onClick={() => void signOut()}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
