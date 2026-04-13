import { useEffect, useState, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { AnnotatedEditor } from "@/components/tiptap/AnnotatedEditor";
import { BlindLabelBadge } from "@/components/BlindLabelBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PreferenceRating } from "@/components/PreferenceRating";
import { RunComment } from "@/components/RunComment";
import { ArrowLeft, Send } from "lucide-react";

export function BlindEvalView() {
  const { opaqueRunToken } = useParams<{ opaqueRunToken: string }>();
  const navigate = useNavigate();
  const [submitted, setSubmitted] = useState(false);

  const data = useQuery(
    api.runs.getOutputsForEvaluator,
    opaqueRunToken ? { opaqueToken: opaqueRunToken } : "skip",
  );

  const addFeedback = useMutation(api.feedback.addOutputFeedbackByToken);

  // Set page title per security rule #3
  useEffect(() => {
    if (data) {
      document.title = `Evaluation — ${data.projectName}`;
    }
    return () => {
      document.title = "Hot or Prompt";
    };
  }, [data]);

  const handleCreateAnnotation = useCallback(
    (
      blindLabel: string,
      from: number,
      to: number,
      highlightedText: string,
      comment: string,
    ) => {
      if (!opaqueRunToken) return;
      addFeedback({
        opaqueToken: opaqueRunToken,
        blindLabel,
        annotationData: { from, to, highlightedText, comment },
      });
    },
    [opaqueRunToken, addFeedback],
  );

  if (data === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-64" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  // Token invalid or expired — redirect to inbox
  if (data === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            This evaluation link has expired or is invalid.
          </p>
          <Link
            to="/eval"
            className="text-sm text-primary hover:underline"
          >
            Back to inbox
          </Link>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="text-center space-y-3">
          <p className="text-lg font-medium">Feedback submitted</p>
          <p className="text-sm text-muted-foreground">
            Thank you for your evaluation.
          </p>
          <Button variant="outline" onClick={() => navigate("/eval")}>
            Back to inbox
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header — minimal per security rules */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/eval"
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-sm font-medium">
            Evaluation — {data.projectName}
          </span>
        </div>
        <Button size="sm" onClick={() => setSubmitted(true)}>
          <Send className="mr-1.5 h-3.5 w-3.5" />
          Submit feedback
        </Button>
      </div>

      {/* Instruction card */}
      <div className="px-4 py-3 bg-muted/30 border-b">
        <p className="text-sm text-muted-foreground">
          Rate each output and leave feedback by selecting text and commenting.
          Outputs are labeled A/B/C to remove bias. Submit when you're done.
        </p>
      </div>

      {/* Three-column output grid */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-3 gap-4 min-h-[400px]">
          {data.outputs.map((output) => (
            <div
              key={output.blindLabel}
              className="flex flex-col rounded-lg border bg-card"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-3 py-2 border-b">
                <BlindLabelBadge label={output.blindLabel} />
                {output.annotations.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {output.annotations.length} comment
                    {output.annotations.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {/* Annotatable output */}
              <div className="flex-1 overflow-y-auto">
                <AnnotatedEditor
                  content={output.outputContent}
                  annotations={output.annotations.map((a) => ({
                    from: a.from,
                    to: a.to,
                    highlightedText: a.highlightedText,
                    comment: a.comment,
                    // No _id, no authorName — evaluator view is anonymous
                  }))}
                  canAnnotate={true}
                  showAuthor={false}
                  onCreateAnnotation={(from, to, highlightedText, comment) => {
                    handleCreateAnnotation(
                      output.blindLabel,
                      from,
                      to,
                      highlightedText,
                      comment,
                    );
                  }}
                />
              </div>

              {/* Preference rating */}
              <div className="px-3 py-2 border-t">
                <PreferenceRating
                  mode="eval"
                  opaqueToken={opaqueRunToken!}
                  blindLabel={output.blindLabel}
                />
              </div>
            </div>
          ))}
        </div>

        {/* General comment section */}
        <RunComment mode="eval" opaqueToken={opaqueRunToken!} />
      </div>
    </div>
  );
}
