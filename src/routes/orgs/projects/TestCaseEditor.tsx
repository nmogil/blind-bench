import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, Link } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageVariableUploader } from "@/components/ImageVariableUploader";
import { friendlyError } from "@/lib/errors";
import { ArrowLeft, Paperclip } from "lucide-react";

type StorageId = Id<"_storage">;

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
  const deleteImageBlob = useMutation(
    api.imageVariableAttachments.deleteAttachment,
  );

  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, StorageId>>({});
  // Per-session metadata (filename, size) for freshly uploaded images so the
  // UI can show those details before the test case is persisted.
  const [pendingMeta, setPendingMeta] = useState<
    Record<string, { filename: string; sizeBytes: number }>
  >({});
  // Storage IDs uploaded this session that are NOT yet persisted on the test
  // case. If the user navigates away or replaces them, we delete the blob so
  // we never leak orphans.
  const pendingUploadsRef = useRef<Set<StorageId>>(new Set());
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

    const mergedValues: Record<string, string> = {};
    for (const v of variables) {
      mergedValues[v.name] =
        testCase.variableValues[v.name] ?? v.defaultValue ?? "";
    }
    setValues(mergedValues);

    setAttachments(testCase.variableAttachments ?? {});
    setPendingMeta({});
    pendingUploadsRef.current = new Set();
  }, [initialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // Best-effort orphan cleanup: any storage ID uploaded this session but not
  // committed to the test case gets deleted on unmount.
  useEffect(() => {
    return () => {
      const pending = pendingUploadsRef.current;
      for (const storageId of pending) {
        // Fire-and-forget — we're unmounting and don't want to block.
        deleteImageBlob({ projectId, storageId }).catch(() => {});
      }
    };
  }, [deleteImageBlob, projectId]);

  function handleImageUploaded(
    variableName: string,
    storageId: StorageId,
    meta: { filename: string; sizeBytes: number; mimeType: string },
  ) {
    // If the slot already held a pending (uploaded-but-unsaved) blob, free it
    // immediately so a Replace doesn't leak.
    const prev = attachments[variableName];
    if (prev && pendingUploadsRef.current.has(prev)) {
      pendingUploadsRef.current.delete(prev);
      void deleteImageBlob({ projectId, storageId: prev }).catch(() => {});
    }
    pendingUploadsRef.current.add(storageId);
    setAttachments((m) => ({ ...m, [variableName]: storageId }));
    setPendingMeta((m) => ({
      ...m,
      [variableName]: { filename: meta.filename, sizeBytes: meta.sizeBytes },
    }));
  }

  function handleImageRemoved(variableName: string) {
    const prev = attachments[variableName];
    if (prev && pendingUploadsRef.current.has(prev)) {
      pendingUploadsRef.current.delete(prev);
      void deleteImageBlob({ projectId, storageId: prev }).catch(() => {});
    }
    // Persisted (already-saved) blobs are deleted server-side on save, when
    // testCases.update sees the slot disappear from variableAttachments.
    setAttachments((m) => {
      const next = { ...m };
      delete next[variableName];
      return next;
    });
    setPendingMeta((m) => {
      const next = { ...m };
      delete next[variableName];
      return next;
    });
  }

  function validateRequiredImages(): string | null {
    if (!variables) return null;
    for (const v of variables) {
      if (v.type === "image" && v.required && !attachments[v.name]) {
        return `Image variable "${v.name}" is required.`;
      }
    }
    return null;
  }

  async function handleSave() {
    if (!testCaseId) return;
    const reqError = validateRequiredImages();
    if (reqError) {
      setError(reqError);
      return;
    }
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      await updateTestCase({
        testCaseId: testCaseId as Id<"testCases">,
        name: name.trim(),
        variableValues: values,
        variableAttachments: attachments,
      });
      // Anything pending is now committed.
      pendingUploadsRef.current = new Set();
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
            No variables defined for this prompt yet. Add variables first.
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
                {v.type === "image" ? (
                  <ImageVariableUploader
                    projectId={projectId}
                    storageId={attachments[v.name] ?? null}
                    pendingMeta={pendingMeta[v.name] ?? null}
                    required={v.required}
                    onUploaded={(storageId, meta) =>
                      handleImageUploaded(v.name, storageId, meta)
                    }
                    onRemoved={() => handleImageRemoved(v.name)}
                  />
                ) : (
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
                )}
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
        <p className="text-sm text-sky-700 dark:text-sky-300">Saved successfully.</p>
      )}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
