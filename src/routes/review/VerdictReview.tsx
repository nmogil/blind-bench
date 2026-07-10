import { useEffect, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useParams } from "react-router-dom";
import { Check, EyeOff, Lock } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TraceTokenReviewBody } from "@/routes/traces/TraceTokenReviewBody";
import { friendlyError } from "@/lib/errors";

/** Public no-account entry for a blind single-run or batch verdict review. */
export function VerdictReview() {
  const { shareToken = "" } = useParams<{ shareToken: string }>();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn } = useAuthActions();
  const [name, setName] = useState("");
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    document.title = "Blind run review — Blind Bench";
  }, []);

  async function begin(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setError("");
    try {
      if (!isAuthenticated) await signIn("anonymous");
      setStarted(true);
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not start this review."));
    }
  }

  if (isLoading) return <ReviewShell><p className="text-sm text-muted-foreground">Preparing blind review…</p></ReviewShell>;
  if (started && isAuthenticated) {
    return <JoinedReview shareToken={shareToken} reviewerName={name.trim()} />;
  }

  return (
    <ReviewShell>
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><EyeOff className="h-6 w-6" /></div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Blind run review</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Judge completed AI runs without seeing which model, harness, or source produced them. You can comment on the exact step where quality changed.
        </p>
        <form onSubmit={begin} className="mt-6 space-y-3 text-left">
          <label htmlFor="verdict-reviewer-name" className="text-sm font-medium">Your display name</label>
          <Input id="verdict-reviewer-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Alex" maxLength={80} />
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button className="w-full" type="submit" disabled={!name.trim()}>Start review</Button>
        </form>
        <p className="mt-4 text-xs text-muted-foreground">No Blind Bench account required. This link does not grant project access.</p>
      </div>
    </ReviewShell>
  );
}

function JoinedReview({ shareToken, reviewerName }: { readonly shareToken: string; readonly reviewerName: string }) {
  const join = useMutation(api.verdictReviewCampaigns.joinCampaign);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void join({ shareToken, displayName: reviewerName })
      .then((result) => {
        if (!cancelled) setToken(result.sessionToken);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(friendlyError(cause, "This review link could not be opened."));
      });
    return () => { cancelled = true; };
  }, [join, reviewerName, shareToken]);

  if (error) return <ReviewShell><p className="text-sm text-destructive" role="alert">{error}</p></ReviewShell>;
  if (!token) return <ReviewShell><p className="text-sm text-muted-foreground">Opening review…</p></ReviewShell>;
  return <ReviewDeck token={token} />;
}

function ReviewDeck({ token }: { readonly token: string }) {
  const review = useQuery(api.verdictReviewCampaigns.getReview, { sessionToken: token });
  if (review === undefined) return <ReviewShell><p className="text-sm text-muted-foreground">Loading next run…</p></ReviewShell>;
  if (review.status === "closed") {
    return <ReviewShell><Completion icon={Lock} title="Review closed" detail="The workspace owner closed this review. Your saved judgments are preserved." /></ReviewShell>;
  }
  if (review.complete) {
    return <ReviewShell><Completion icon={Check} title="Review complete" detail={`You reviewed ${review.progress.judged} of ${review.progress.total} runs. Your judgments are saved.`} /></ReviewShell>;
  }

  return (
    <ReviewShell wide>
      <header className="mx-auto mb-2 max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Blind run review</p>
            <h1 className="mt-1 text-lg font-semibold">{review.instructions || "Check whether this run handled the task correctly."}</h1>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>{review.progress.judged + 1} / {review.progress.total}</div>
            <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${(review.progress.judged / review.progress.total) * 100}%` }} /></div>
          </div>
        </div>
      </header>
      <TraceTokenReviewBody key={review.progress.judged} token={token} showBackLink={false} />
    </ReviewShell>
  );
}

function Completion({ icon: Icon, title, detail }: { readonly icon: typeof Check; readonly title: string; readonly detail: string }) {
  return <div className="mx-auto max-w-md text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary"><Icon className="h-6 w-6" /></div><h1 className="mt-4 text-2xl font-semibold">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{detail}</p></div>;
}

function ReviewShell({ children, wide = false }: { readonly children: React.ReactNode; readonly wide?: boolean }) {
  return <main className="min-h-screen bg-muted/20 p-4 sm:p-8"><div className={`mx-auto ${wide ? "max-w-5xl" : "max-w-xl"}`}><div className="mb-8 flex items-center gap-2 text-sm font-semibold"><EyeOff className="h-4 w-4 text-primary" /> Blind Bench</div>{children}</div></main>;
}
