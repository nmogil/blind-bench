import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface RunCommentAuthProps {
  mode: "auth";
  runId: Id<"promptRuns">;
}

interface RunCommentEvalProps {
  mode: "eval";
  opaqueToken: string;
}

type RunCommentProps = RunCommentAuthProps | RunCommentEvalProps;

export function RunComment(props: RunCommentProps) {
  if (props.mode === "auth") {
    return <AuthRunComment runId={props.runId} />;
  }
  return <EvalRunComment opaqueToken={props.opaqueToken} />;
}

function AuthRunComment({ runId }: { runId: Id<"promptRuns"> }) {
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

function EvalRunComment({ opaqueToken }: { opaqueToken: string }) {
  const existing = useQuery(api.runComments.getMyCommentByToken, { opaqueToken });
  const upsert = useMutation(api.runComments.upsertCommentByToken);

  const save = useCallback(
    (value: string) => upsert({ opaqueToken, comment: value }),
    [opaqueToken, upsert],
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
        className="flex items-center gap-1.5 w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        General notes about this run
        {saved && (
          <span className="ml-auto flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <Check className="h-3 w-3" />
            Saved
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
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
