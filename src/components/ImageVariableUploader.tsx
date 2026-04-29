import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { ImageIcon, Upload, X } from "lucide-react";

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

interface ImageVariableUploaderProps {
  projectId: Id<"projects">;
  storageId: Id<"_storage"> | null;
  // Filename + size shown for the current session before the test case is saved.
  // After save the values come from getUrl() metadata instead.
  pendingMeta?: { filename: string; sizeBytes: number } | null;
  onUploaded: (
    storageId: Id<"_storage">,
    meta: { filename: string; sizeBytes: number; mimeType: string },
  ) => void;
  onRemoved: () => void;
  required?: boolean;
}

export function ImageVariableUploader({
  projectId,
  storageId,
  pendingMeta,
  onUploaded,
  onRemoved,
  required,
}: ImageVariableUploaderProps) {
  const generateUploadUrl = useMutation(
    api.imageVariableAttachments.generateUploadUrl,
  );
  const finalize = useMutation(api.imageVariableAttachments.finalize);
  const persistedMeta = useQuery(
    api.imageVariableAttachments.getUrl,
    storageId ? { projectId, storageId } : "skip",
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);

  function validateLocally(file: File): string | null {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return "Unsupported image format. Allowed: JPEG, PNG, WebP, GIF";
    }
    if (file.size === 0) return "File is empty";
    if (file.size > MAX_SIZE_BYTES) return "Image must be 5MB or smaller";
    return null;
  }

  async function uploadFile(file: File) {
    const localError = validateLocally(file);
    if (localError) {
      setError(localError);
      return;
    }

    setUploading(true);
    setError("");
    try {
      const uploadUrl = await generateUploadUrl({ projectId });
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { storageId: newId } = (await res.json()) as {
        storageId: Id<"_storage">;
      };

      // Server-side validation. finalize() deletes the blob on rejection so
      // we don't need a follow-up cleanup here.
      const result = await finalize({ projectId, storageId: newId });
      onUploaded(result.storageId, {
        filename: file.name,
        sizeBytes: result.sizeBytes,
        mimeType: result.mimeType,
      });
    } catch (err) {
      setError(friendlyError(err, "Failed to upload image."));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onPick() {
    fileInputRef.current?.click();
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
  }

  // Empty state — no storage ID assigned yet
  if (!storageId) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          onClick={onPick}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          className={cn(
            "flex w-full max-w-md items-center justify-center gap-2 rounded-md border border-dashed p-6 text-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            dragActive
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/30 hover:border-muted-foreground/50",
            uploading && "cursor-wait opacity-60",
          )}
          disabled={uploading}
        >
          {uploading ? (
            <span className="text-muted-foreground">Uploading…</span>
          ) : (
            <>
              <Upload className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                Drop an image or click to upload
              </span>
            </>
          )}
        </button>
        <p className="text-xs text-muted-foreground">
          JPEG, PNG, WebP, or GIF. Max 5MB.
          {required && (
            <span className="ml-1 text-destructive">Required.</span>
          )}
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_MIME_TYPES.join(",")}
          onChange={onChange}
          className="hidden"
        />
      </div>
    );
  }

  // Resolved state — show thumbnail + metadata
  const meta = pendingMeta
    ? { filename: pendingMeta.filename, sizeBytes: pendingMeta.sizeBytes }
    : persistedMeta
      ? { filename: "Uploaded image", sizeBytes: persistedMeta.sizeBytes }
      : null;
  const url = persistedMeta?.url ?? null;
  const loading = persistedMeta === undefined && !pendingMeta;

  return (
    <div className="space-y-2">
      <div className="flex w-full max-w-md items-center gap-3 rounded-md border p-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm border bg-muted">
          {loading ? (
            <Skeleton className="h-full w-full" />
          ) : url ? (
            <img
              src={url}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {meta?.filename ?? "Uploaded image"}
          </p>
          <p className="text-xs text-muted-foreground">
            {meta ? formatBytes(meta.sizeBytes) : "—"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onPick}
            disabled={uploading}
          >
            {uploading ? "Uploading…" : "Replace"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onRemoved}
            disabled={uploading}
            aria-label="Remove image"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_MIME_TYPES.join(",")}
        onChange={onChange}
        className="hidden"
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
