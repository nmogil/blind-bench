import { useEffect, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "motion/react";
import { useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, EyeOff, MessageSquarePlus } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import {
  comparisonChoiceForKey,
  comparisonChoiceForSwipe,
  type VisibleComparisonChoice,
} from "@/lib/evals/comparisonControls";

type VisibleChoice = VisibleComparisonChoice;
type SessionToken = string;

export function ComparisonReview() {
  const { shareToken = "" } = useParams<{ shareToken: string }>();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn } = useAuthActions();
  const [name, setName] = useState("");
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");

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
  if (started && isAuthenticated) return <JoinedReview shareToken={shareToken} reviewerName={name.trim()} />;

  return <ReviewShell>
    <div className="mx-auto max-w-md text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><EyeOff className="h-6 w-6" /></div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">Blind comparison</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">Review five paired attempts without seeing which model or system produced them. Your name is shown only to the workspace owner.</p>
      <form onSubmit={begin} className="mt-6 space-y-3 text-left">
        <label htmlFor="reviewer-name" className="text-sm font-medium">Your display name</label>
        <Input id="reviewer-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Dan" maxLength={80} />
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button className="w-full" type="submit" disabled={!name.trim()}>Start five reviews</Button>
      </form>
      <p className="mt-4 text-xs text-muted-foreground">No Blind Bench account required. This link does not grant project access.</p>
    </div>
  </ReviewShell>;
}

function JoinedReview({ shareToken, reviewerName }: { shareToken: string; reviewerName: string }) {
  const join = useMutation(api.comparisonCampaigns.joinCampaign);
  const [token, setToken] = useState<SessionToken | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void join({ shareToken, displayName: reviewerName }).then((result) => {
      if (!cancelled) setToken(result.sessionToken);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(friendlyError(cause, "This review link could not be opened."));
    });
    return () => { cancelled = true; };
  }, [join, reviewerName, shareToken]);

  if (error) return <ReviewShell><p className="text-sm text-destructive" role="alert">{error}</p></ReviewShell>;
  if (!token) return <ReviewShell><p className="text-sm text-muted-foreground">Opening review…</p></ReviewShell>;
  return <ReviewDeck token={token} />;
}

function ReviewDeck({ token }: { token: SessionToken }) {
  const review = useQuery(api.comparisonCampaigns.getReview, { sessionToken: token });
  const getContent = useAction(api.comparisonCampaigns.getCurrentContent);
  const submit = useMutation(api.comparisonCampaigns.submitChoice);
  const addFive = useMutation(api.comparisonCampaigns.extendBatch);
  const addComment = useMutation(api.agentTraceReviewSessions.addMatchupComment);
  const reduceMotion = useReducedMotion();
  const [content, setContent] = useState<{ context: string; firstCandidate: string; secondCandidate: string } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const position = review?.current?.position;
  const reviewStatus = review?.status;
  useEffect(() => {
    if (position === undefined || reviewStatus !== "open") { setContent(null); return; }
    let cancelled = false;
    setContent(null);
    void getContent({ sessionToken: token }).then((next) => { if (!cancelled) setContent(next); }).catch((cause: unknown) => { if (!cancelled) setError(friendlyError(cause, "Could not load this comparison.")); });
    return () => { cancelled = true; };
  }, [getContent, position, reviewStatus, token]);

  async function choose(choice: VisibleChoice) {
    if (busy || !review?.current) return;
    setBusy(true); setError("");
    try {
      await submit({ sessionToken: token, position: review.current.position, choice, note: note.trim() || undefined });
      setNote("");
    } catch (cause: unknown) { setError(friendlyError(cause, "Could not save this judgment.")); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || event.metaKey || event.ctrlKey || event.altKey) return;
      const choice = comparisonChoiceForKey(event.key);
      if (choice) { event.preventDefault(); void choose(choice); }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  if (review === undefined) return <ReviewShell><p className="text-sm text-muted-foreground">Loading comparison…</p></ReviewShell>;
  if (review.status === "closed") return <ReviewShell><div className="mx-auto max-w-md text-center"><LockNotice /></div></ReviewShell>;
  if (review.batchComplete) return <ReviewShell>
    <div className="mx-auto max-w-md text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary"><Check className="h-6 w-6" /></div><h1 className="mt-4 text-2xl font-semibold">Batch complete</h1><p className="mt-2 text-sm text-muted-foreground">You reviewed {review.progress.judged} of {review.progress.total} cases in this campaign.</p>{!review.allComplete && <Button className="mt-6" onClick={() => void addFive({ sessionToken: token })}>Review 5 more</Button>}</div>
  </ReviewShell>;

  const current = review.current;
  if (!current || !content) return <ReviewShell><p className="text-sm text-muted-foreground">Loading next pair…</p></ReviewShell>;
  const commentTarget = (side: typeof current.firstSide) => ({
    side,
    target: current.candidateStep.kind === "tool_call"
      ? { kind: "tool_call" as const, stepIndex: current.candidateStep.stepIndex }
      : { kind: "step" as const, stepIndex: current.candidateStep.stepIndex },
  });

  return <ReviewShell wide>
    <header className="mb-4 flex items-center justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{review.title}</p><h1 className="text-lg font-semibold">Which attempt is better?</h1></div><div className="text-right text-xs text-muted-foreground"><div>{review.progress.judged + 1} / {review.progress.visible}</div><div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${(review.progress.judged / review.progress.visible) * 100}%` }} /></div></div></header>
    {content.context && <section className="mb-4 max-h-48 overflow-auto rounded-xl border bg-muted/30 p-4"><p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Shared context</p><pre className="whitespace-pre-wrap font-sans text-sm leading-6">{content.context}</pre></section>}
    <AnimatePresence mode="wait">
      <motion.div key={current.position} drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.18} onDragEnd={(_, info: PanInfo) => { const choice = comparisonChoiceForSwipe(info.offset.x); if (choice) void choose(choice); }} initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }} className="grid touch-pan-y gap-3 md:grid-cols-2">
        <CandidateCard label="Attempt 1" content={content.firstCandidate} shortcut="←" disabled={busy} onChoose={() => void choose("first")} onComment={(comment) => addComment({ token, ...commentTarget(current.firstSide), comment, label: "thought" })} />
        <CandidateCard label="Attempt 2" content={content.secondCandidate} shortcut="→" disabled={busy} onChoose={() => void choose("second")} onComment={(comment) => addComment({ token, ...commentTarget(current.secondSide), comment, label: "thought" })} />
      </motion.div>
    </AnimatePresence>
    <div className="mt-4 grid grid-cols-3 gap-2"><Button variant="outline" onClick={() => void choose("same")} disabled={busy}>Same <kbd className="ml-2 text-[10px]">=</kbd></Button><Button variant="outline" onClick={() => void choose("neither")} disabled={busy}>Neither <kbd className="ml-2 text-[10px]">N</kbd></Button><Button variant="outline" onClick={() => void choose("cannot_judge")} disabled={busy}>Cannot judge <kbd className="ml-2 text-[10px]">S</kbd></Button></div>
    <Textarea className="mt-3 min-h-16" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional note about this choice…" maxLength={2_000} />
    {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
    <p className="mt-3 text-center text-xs text-muted-foreground"><ArrowLeft className="inline h-3 w-3" /> / <ArrowRight className="inline h-3 w-3" /> keys, click, or swipe horizontally</p>
  </ReviewShell>;
}

function CandidateCard({ label, content, shortcut, disabled, onChoose, onComment }: { label: string; content: string; shortcut: string; disabled: boolean; onChoose: () => void; onComment: (comment: string) => Promise<unknown> }) {
  const [commenting, setCommenting] = useState(false); const [comment, setComment] = useState(""); const [commentError, setCommentError] = useState(""); const [saving, setSaving] = useState(false);
  async function saveComment() {
    if (!comment.trim() || saving) return;
    setSaving(true); setCommentError("");
    try { await onComment(comment.trim()); setComment(""); setCommenting(false); }
    catch (cause: unknown) { setCommentError(friendlyError(cause, "Could not save this step comment.")); }
    finally { setSaving(false); }
  }
  return <article className="flex min-h-64 flex-col rounded-2xl border bg-background shadow-sm"><button type="button" disabled={disabled} onClick={onChoose} className="flex flex-1 flex-col p-5 text-left outline-none ring-primary/40 hover:bg-muted/20 focus-visible:ring-2"><div className="flex w-full justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground"><span>{label}</span><kbd>{shortcut}</kbd></div><pre className="mt-4 whitespace-pre-wrap font-sans text-sm leading-6">{content}</pre></button><div className="border-t p-3">{commenting ? <><div className="flex gap-2"><Input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Step-level comment…" maxLength={2_000} /><Button size="sm" variant="outline" disabled={saving} onClick={() => void saveComment()}>Save</Button></div>{commentError && <p className="mt-2 text-xs text-destructive" role="alert">{commentError}</p>}</> : <button type="button" onClick={() => setCommenting(true)} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><MessageSquarePlus className="h-3.5 w-3.5" /> Comment on this step</button>}</div></article>;
}

function LockNotice() {
  return <><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"><Check className="h-6 w-6" /></div><h1 className="mt-4 text-2xl font-semibold">Review closed</h1><p className="mt-2 text-sm text-muted-foreground">The workspace owner has closed this comparison. Your saved judgments are preserved.</p></>;
}

function ReviewShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <main className="min-h-screen bg-muted/20 p-4 sm:p-8"><div className={`mx-auto ${wide ? "max-w-6xl" : "max-w-xl"}`}><div className="mb-8 flex items-center gap-2 text-sm font-semibold"><EyeOff className="h-4 w-4 text-primary" /> Blind Bench</div>{children}</div></main>;
}
