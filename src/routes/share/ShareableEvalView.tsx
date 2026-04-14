import { useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { BlindLabelBadge } from "@/components/BlindLabelBadge";
import { RatingButtons, type Rating, RATINGS } from "@/components/RatingButtons";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsPanel } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Check } from "lucide-react";

function getSessionId(): string {
  const key = "blind-bench-session-id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

export function ShareableEvalView() {
  const { token } = useParams<{ token: string }>();
  const resolved = useQuery(
    api.shareableLinks.resolveShareableLink,
    token ? { token } : "skip",
  );

  const submitPreferences = useMutation(
    api.shareableLinks.submitAnonymousPreferences,
  );

  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const isMobile = useIsMobile();

  const sessionId = useMemo(() => getSessionId(), []);

  // Loading
  if (resolved === undefined) {
    return (
      <PageShell>
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-48 rounded-xl" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
        </div>
      </PageShell>
    );
  }

  // Invalid / expired
  if (resolved === null) {
    return (
      <PageShell>
        <div className="py-16 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Link expired or unavailable
          </h1>
          <p className="mt-2 text-muted-foreground">
            This blind comparison link is no longer active. Ask the person who
            shared it to generate a new one.
          </p>
          <Link
            to="/"
            className="mt-4 inline-block text-sm text-primary hover:underline"
          >
            Go to Blind Bench
          </Link>
        </div>
      </PageShell>
    );
  }

  const totalCount = resolved.outputs.length;
  const ratedCount = Object.keys(ratings).length;
  const allRated = ratedCount === totalCount;

  function handleRate(blindLabel: string, rating: Rating) {
    setRatings((prev) => {
      if (prev[blindLabel] === rating) {
        const next = { ...prev };
        delete next[blindLabel];
        return next;
      }
      return { ...prev, [blindLabel]: rating };
    });
  }

  async function handleSubmit() {
    if (!token || !allRated) return;
    setSubmitting(true);
    try {
      await submitPreferences({
        token,
        sessionId,
        ratings: Object.entries(ratings).map(([blindLabel, rating]) => ({
          blindLabel,
          rating,
        })),
      });
      setSubmitted(true);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to submit. You may have already voted.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Thank-you state
  if (submitted) {
    return (
      <PageShell>
        <div className="py-12 space-y-6">
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">
              Thanks for your evaluation
            </h1>
            <p className="mt-2 text-muted-foreground">
              Your preferences have been recorded. The prompt engineer who shared
              this will see your feedback.
            </p>
          </div>

          <div className="rounded-xl border bg-card shadow-sm p-4 space-y-3">
            <h2 className="text-sm font-medium">Your ratings</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(ratings).map(([label, rating]) => {
                const ratingDef = RATINGS.find((r) => r.value === rating);
                return (
                  <div
                    key={label}
                    className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2"
                  >
                    <BlindLabelBadge label={label} />
                    <span
                      className={cn(
                        "text-xs font-medium px-2 py-0.5 rounded-full",
                        ratingDef?.activeClass,
                      )}
                    >
                      {rating.charAt(0).toUpperCase() + rating.slice(1)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-muted/30 p-6 text-center">
            <p className="text-sm font-medium">
              Want blind evaluation for your whole team?
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Run real LLM outputs through blind evaluation, collect
              annotations, and optimize prompts with AI.
            </p>
            <Link
              to="/auth/sign-in"
              className="mt-3 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Sign up for Blind Bench
            </Link>
          </div>
        </div>
      </PageShell>
    );
  }

  // Main evaluation view
  return (
    <PageShell>
      <div className="space-y-5 pb-24">
        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {resolved.projectName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Blind Comparison — each output is labeled with a letter so you can
            rate without knowing which model produced it.
          </p>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-3">
          <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${(ratedCount / totalCount) * 100}%` }}
            />
          </div>
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {ratedCount} of {totalCount} rated
          </span>
        </div>

        {/* Outputs — tabs on mobile, grid on desktop */}
        {isMobile ? (
          <Tabs defaultValue={resolved.outputs[0]?.blindLabel}>
            <TabsList className="w-full">
              {resolved.outputs.map(({ blindLabel }) => (
                <TabsTrigger
                  key={blindLabel}
                  value={blindLabel}
                  className="flex-1 gap-1.5"
                >
                  <BlindLabelBadge label={blindLabel} />
                  {ratings[blindLabel] !== undefined && (
                    <Check className="h-3 w-3 text-primary" />
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
            {resolved.outputs.map(({ blindLabel, outputContent }) => (
              <TabsPanel key={blindLabel} value={blindLabel}>
                <OutputCard
                  blindLabel={blindLabel}
                  outputContent={outputContent}
                  currentRating={ratings[blindLabel] ?? null}
                  onRate={(rating) => handleRate(blindLabel, rating)}
                  isRated={ratings[blindLabel] !== undefined}
                />
              </TabsPanel>
            ))}
          </Tabs>
        ) : (
          <div
            className={cn(
              "grid gap-4",
              totalCount === 2
                ? "sm:grid-cols-2"
                : "sm:grid-cols-2 lg:grid-cols-3",
            )}
          >
            {resolved.outputs.map(({ blindLabel, outputContent }) => (
              <OutputCard
                key={blindLabel}
                blindLabel={blindLabel}
                outputContent={outputContent}
                currentRating={ratings[blindLabel] ?? null}
                onRate={(rating) => handleRate(blindLabel, rating)}
                isRated={ratings[blindLabel] !== undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* Sticky submit footer */}
      <div className="fixed bottom-0 inset-x-0 z-20 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto max-w-4xl flex items-center justify-between px-4 py-3">
          <span className="text-sm text-muted-foreground">
            {ratedCount} of {totalCount} rated
          </span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allRated || submitting}
            className={cn(
              "rounded-md px-5 py-2 text-sm font-medium transition-colors",
              allRated && !submitting
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground cursor-not-allowed",
            )}
          >
            {submitting ? "Submitting..." : "Submit Preferences"}
          </button>
        </div>
      </div>
    </PageShell>
  );
}

function OutputCard({
  blindLabel,
  outputContent,
  currentRating,
  onRate,
  isRated,
}: {
  blindLabel: string;
  outputContent: string;
  currentRating: Rating | null;
  onRate: (rating: Rating) => void;
  isRated: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-card shadow-sm max-h-[70vh] overflow-hidden transition-colors duration-200",
        isRated && "border-l-4 border-l-primary/60",
      )}
    >
      {/* Sticky header */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-border/50 bg-card/95 backdrop-blur-sm">
        <BlindLabelBadge label={blindLabel} />
        <RatingButtons currentRating={currentRating} onRate={onRate} />
      </div>
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {outputContent}
        </div>
      </div>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-4xl items-center px-4">
          <Link to="/" className="font-semibold tracking-tight">
            Blind Bench
          </Link>
          <span className="ml-2 text-sm text-muted-foreground">
            Blind Comparison
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      <footer className="border-t border-border py-4 text-center text-xs text-muted-foreground">
        Evaluated with{" "}
        <a
          href="https://blindbench.dev"
          className="underline hover:text-foreground"
          target="_blank"
          rel="noopener noreferrer"
        >
          Blind Bench
        </a>
      </footer>
    </div>
  );
}
