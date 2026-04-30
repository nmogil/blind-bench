import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";
import { NextActionRing } from "@/components/copilot/NextActionRing";
import { Key, ExternalLink } from "lucide-react";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function OpenRouterKey() {
  const { role } = useOrg();

  if (role !== "owner") {
    return <Navigate to="/denied" replace />;
  }

  return <OpenRouterKeyForm />;
}

function OpenRouterKeyForm() {
  const { orgId } = useOrg();
  const keyStatus = useQuery(api.openRouterKeys.hasKey, { orgId });
  const setKeyAction = useAction(api.openRouterKeys.setKey);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  if (keyStatus === undefined) {
    return (
      <div className="p-6 max-w-xl">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      await setKeyAction({ orgId, key: key.trim() });
      setKey("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(friendlyError(err, "Failed to save API key. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 max-w-xl">
      <h1 className="text-2xl font-bold">OpenRouter API key</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your key is encrypted at rest and never visible after saving.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Key className="h-4 w-4" />
            API key
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status line */}
          <div className="text-sm">
            {keyStatus.hasKey ? (
              <span className="text-sky-700 dark:text-sky-300">
                Key set &middot; last rotated{" "}
                {formatRelativeTime(keyStatus.lastRotatedAt!)}
              </span>
            ) : (
              <span className="text-muted-foreground">No key set</span>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="openrouter-key">
                {keyStatus.hasKey ? "New key" : "API key"}
              </Label>
              <Input
                id="openrouter-key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-or-..."
                autoComplete="off"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && (
              <p className="text-sm text-sky-700 dark:text-sky-300">Key saved successfully.</p>
            )}

            <NextActionRing target="add_key">
              <Button type="submit" disabled={saving || !key.trim()}>
                {saving ? "Saving..." : "Save key"}
              </Button>
            </NextActionRing>
          </form>

          <p className="text-xs text-muted-foreground pt-2 border-t">
            Get your API key from the{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1"
            >
              OpenRouter dashboard
              <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
