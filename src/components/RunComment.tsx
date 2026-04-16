import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface RunCommentProps {
  runId: Id<"promptRuns">;
}

export function RunComment({ runId }: RunCommentProps) {
  const existing = useQuery(api.runComments.getMyComment, { runId });
  const upsert = useMutation(api.runComments.upsertComment);

  const save = useCallback(
    (value: string) => upsert({ runId, comment: value }),
    [runId, upsert],
  );

  return (
    <RunCommentEditor
      initialComment={existing?.comment ?? null}
      loading={existing === undefined}
      onSave={save}
    />
  );
}

const SOFT_LIMIT = 500;
const DEBOUNCE_MS = 500;

function RunCommentEditor({
  initialComment,
  loading,
  onSave,
}: {
  initialComment: string | null;
  loading: boolean;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Initialize from server state once loaded
  useEffect(() => {
    if (!loading && !initialized) {
      if (initialComment) {
        setText(initialComment);
        setExpanded(true);
      }
      setInitialized(true);
    }
  }, [loading, initialComment, initialized]);

  const doSave = useCallback(
    async (value: string) => {
      try {
        await onSave(value);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch {
        // Silently fail — debounce will retry on next keystroke
      }
    },
    [onSave],
  );

  const handleChange = (value: string) => {
    setText(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSave(value), DEBOUNCE_MS);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        className="flex items-center gap-1.5 w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls="run-general-notes"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        General notes about this run
        {saved && (
          <span className="ml-auto flex items-center gap-1 text-xs text-sky-700 dark:text-sky-300">
            <Check className="h-3 w-3" />
            Saved
          </span>
        )}
      </button>

      {expanded && (
        <div id="run-general-notes" className="px-3 pb-3 space-y-1.5">
          <Textarea
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="Any overall observations? What's working, what's missing?"
            className="resize-none text-sm"
            rows={3}
          />
          <span
            className={cn(
              "text-xs",
              text.length > SOFT_LIMIT
                ? "text-amber-500"
                : "text-muted-foreground",
            )}
          >
            {text.length} / {SOFT_LIMIT} characters
          </span>
        </div>
      )}
    </div>
  );
}
