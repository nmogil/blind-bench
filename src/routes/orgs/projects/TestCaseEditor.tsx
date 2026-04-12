import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, Link } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";
import { ArrowLeft, Paperclip } from "lucide-react";

export function TestCaseEditor() {
  const { projectId } = useProject();
  const { orgSlug, testCaseId } = useParams<{
    orgSlug: string;
    testCaseId: string;
  }>();
  const testCase = useQuery(
    api.testCases.get,
    testCaseId
      ? { testCaseId: testCaseId as Id<"testCases"> }
      : "skip",
  );
  const variables = useQuery(api.variables.list, { projectId });
  const updateTestCase = useMutation(api.testCases.update);

  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  // Initialize form state when data loads
  const initialized = useMemo(() => {
    if (!testCase || !variables) return false;
    return true;
  }, [testCase, variables]);

  useEffect(() => {
    if (!testCase || !variables) return;

    setName(testCase.name);

    // Merge: start with defaults from variables, overlay stored values
    const merged: Record<string, string> = {};
    for (const v of variables) {
      merged[v.name] = testCase.variableValues[v.name] ?? v.defaultValue ?? "";
    }
    setValues(merged);
  }, [initialized]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!testCaseId) return;
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      await updateTestCase({
        testCaseId: testCaseId as Id<"testCases">,
        name: name.trim(),
        variableValues: values,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(friendlyError(err, "Failed to save test case."));
    } finally {
      setSaving(false);
    }
  }

  if (testCase === undefined || variables === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-10 w-full max-w-md" />
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-10 w-full max-w-md" />
          ))}
        </div>
      </div>
    );
  }

  if (testCase === null) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Test case not found.</p>
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/test-cases`}
          className="text-sm text-primary hover:underline mt-2 inline-block"
        >
          Back to test cases
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <Link
        to={`/orgs/${orgSlug}/projects/${projectId}/test-cases`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to test cases
      </Link>

      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="tc-name">Test case name</Label>
        <Input
          id="tc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Happy path"
          className="max-w-md"
        />
      </div>

      {/* Variable values */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium">Variable values</h2>
        {variables.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No variables defined for this project yet. Add variables first.
          </p>
        ) : (
          <div className="space-y-3">
            {variables.map((v) => (
              <div key={v._id} className="space-y-1">
                <Label htmlFor={`var-${v.name}`} className="flex items-center gap-2">
                  <span className="font-mono text-sm">{v.name}</span>
                  {v.required && (
                    <span className="text-xs text-destructive">required</span>
                  )}
                </Label>
                {v.description && (
                  <p className="text-xs text-muted-foreground">
                    {v.description}
                  </p>
                )}
                <Input
                  id={`var-${v.name}`}
                  value={values[v.name] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      [v.name]: e.target.value,
                    }))
                  }
                  placeholder={v.defaultValue ?? ""}
                  className="max-w-md"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Attachment tray (stub) */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Attachments</h2>
        <div className="flex items-center gap-2 rounded-md border border-dashed p-4">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Attachment uploads coming in a future update.
          </p>
        </div>
      </div>

      {/* Actions */}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && (
        <p className="text-sm text-green-600">Saved successfully.</p>
      )}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
