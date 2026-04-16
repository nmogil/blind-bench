import { useEffect, useState, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { AnnotatedEditor } from "@/components/tiptap/AnnotatedEditor";
import { BlindLabelBadge } from "@/components/BlindLabelBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RatingButtons } from "@/components/RatingButtons";
import { ArrowLeft, ChevronLeft, ChevronRight, Send } from "lucide-react";
import { cn } from "@/lib/utils";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < 640 : false,
  );
  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth < 640);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  return isMobile;
}

export function CycleEvalView() {
  const { cycleEvalToken } = useParams<{ cycleEvalToken: string }>();
  const navigate = useNavigate();
  const [submitted, setSubmitted] = useState(false);

  const data = useQuery(
    api.reviewCycles.getOutputsForEvaluator,
    cycleEvalToken ? { cycleEvalToken } : "skip",
  );

  const myRatings = useQuery(
    api.reviewCycles.getMyRatingsForCycle,
    cycleEvalToken ? { cycleEvalToken } : "skip",
  );

  const rateMutation = useMutation(api.reviewCycles.rateCycleOutput);
  const addFeedbackMutation = useMutation(api.reviewCycles.addCycleFeedback);

  // Track local rating state for immediate UI feedback
  const [localRatings, setLocalRatings] = useState<
    Record<string, "best" | "acceptable" | "weak">
  >({});

  // Sync server ratings into local state
  useEffect(() => {
    if (myRatings) {
      const map: Record<string, "best" | "acceptable" | "weak"> = {};
      for (const r of myRatings) {
        map[r.cycleBlindLabel] = r.rating;
      }
      setLocalRatings(map);
    }
  }, [myRatings]);

  // Set page title per security rules
  useEffect(() => {
    if (data) {
      document.title = `Cycle Evaluation — ${data.projectName}`;
    }
    return () => {
      document.title = "Blind Bench";
    };
  }, [data]);

  const handleRate = useCallback(
    async (
      cycleBlindLabel: string,
      rating: "best" | "acceptable" | "weak",
    ) => {
      if (!cycleEvalToken) return;
      setLocalRatings((prev) => ({ ...prev, [cycleBlindLabel]: rating }));
      await rateMutation({ cycleEvalToken, cycleBlindLabel, rating });
    },
    [cycleEvalToken, rateMutation],
  );

  const handleCreateAnnotation = useCallback(
    (
      cycleBlindLabel: string,
      from: number,
      to: number,
      highlightedText: string,
      comment: string,
    ) => {
      if (!cycleEvalToken) return;
      addFeedbackMutation({
        cycleEvalToken,
        cycleBlindLabel,
        annotationData: { from, to, highlightedText, comment },
      });
    },
    [cycleEvalToken, addFeedbackMutation],
  );

  if (data === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-64" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

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
            Thank you for your evaluation of "{data.cycleName}".
          </p>
          <Button variant="outline" onClick={() => navigate("/eval")}>
            Back to inbox
          </Button>
        </div>
      </div>
    );
  }

  const outputCount = data.outputs.length;
  const ratedCount = Object.keys(localRatings).length;
  const isMobile = useIsMobile();
  const [mobileIndex, setMobileIndex] = useState(0);
  const usePagination = isMobile && outputCount >= 7;

  // Adaptive column count based on output count
  const gridCols =
    outputCount <= 3
      ? "grid-cols-1 sm:grid-cols-3"
      : outputCount <= 6
        ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

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
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {ratedCount} of {outputCount} rated
          </span>
          <Button size="sm" onClick={() => setSubmitted(true)}>
            <Send className="mr-1.5 h-3.5 w-3.5" />
            Submit feedback
          </Button>
        </div>
      </div>

      {/* Instruction card */}
      <div className="px-4 py-3 bg-muted/30 border-b">
        <p className="text-sm text-muted-foreground">
          Rate each output and leave feedback by selecting text and commenting.
          Outputs are shuffled and labeled A-{String.fromCharCode(64 + outputCount)} to
          remove bias. Submit when you're done.
        </p>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-muted">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{
            width: `${outputCount > 0 ? (ratedCount / outputCount) * 100 : 0}%`,
          }}
        />
      </div>

      {/* Output grid */}
      <div className="flex-1 overflow-auto p-4">
        {usePagination && (() => {
          const current = data.outputs[mobileIndex];
          if (!current) return null;
          return (
            <div className="flex items-center justify-between mb-3">
              <Button
                variant="outline"
                size="sm"
                disabled={mobileIndex === 0}
                onClick={() => setMobileIndex((i) => i - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
                Prev
              </Button>
              <span className="text-sm text-muted-foreground">
                Output {current.cycleBlindLabel} (
                {mobileIndex + 1} of {outputCount})
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={mobileIndex === outputCount - 1}
                onClick={() => setMobileIndex((i) => i + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          );
        })()}
        <div className={cn("grid gap-4", usePagination ? "grid-cols-1" : gridCols)}>
          {(usePagination
            ? data.outputs.slice(mobileIndex, mobileIndex + 1)
            : data.outputs
          ).map((output) => (
            <div
              key={output.cycleBlindLabel}
              className="flex flex-col rounded-lg border bg-card"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-3 py-2 border-b">
                <BlindLabelBadge label={output.cycleBlindLabel} />
                <div className="flex items-center gap-2">
                  {output.annotations.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {output.annotations.length} comment
                      {output.annotations.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {localRatings[output.cycleBlindLabel] && (
                    <span className="text-xs text-primary">rated</span>
                  )}
                </div>
              </div>

              {/* Annotatable output */}
              <div className="flex-1 overflow-y-auto sm:max-h-[400px]">
                <AnnotatedEditor
                  content={output.outputContentSnapshot}
                  annotations={output.annotations.map((a) => ({
                    from: a.from,
                    to: a.to,
                    highlightedText: a.highlightedText,
                    comment: a.comment,
                  }))}
                  canAnnotate={true}
                  showAuthor={false}
                  onCreateAnnotation={(from, to, highlightedText, comment) => {
                    handleCreateAnnotation(
                      output.cycleBlindLabel,
                      from,
                      to,
                      highlightedText,
                      comment,
                    );
                  }}
                />
              </div>

              {/* Rating */}
              <div className="px-3 py-2 border-t">
                <RatingButtons
                  currentRating={localRatings[output.cycleBlindLabel] ?? null}
                  onRate={(rating) =>
                    handleRate(output.cycleBlindLabel, rating)
                  }
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
