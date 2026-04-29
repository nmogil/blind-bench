import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { ArrowRight, CheckCircle2, Keyboard, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { posthog } from "@/lib/posthog";
import { friendlyError } from "@/lib/errors";

import { BattlePhase } from "./BattlePhase";
import { CheatSheetDialog } from "./CheatSheetDialog";
import { FlashPhase } from "./FlashPhase";
import {
  type CardState,
  type InlineAnnotation,
  type Matchup,
  type Phase,
  type Rating,
  type ReasonTag,
  type ReviewOutput,
} from "./types";

export function SessionDeck() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const data = useQuery(
    api.reviewSessions.get,
    sessionId ? { sessionId: sessionId as Id<"reviewSessions"> } : "skip",
  );

  const saveRating = useMutation(api.reviewSessions.saveRating);
  const saveOverallNote = useMutation(api.reviewSessions.saveOverallNote);
  const addAnnotation = useMutation(api.reviewSessions.addAnnotation);
  const removeAnnotation = useMutation(api.reviewSessions.removeAnnotation);
  const submitPhase1 = useMutation(api.reviewSessions.submitPhase1);
  const recordMatchupMutation = useMutation(api.reviewSessions.recordMatchup);
  const generateNextRound = useMutation(
    api.reviewSessions.generateNextPhase2Round,
  );
  const complete = useMutation(api.reviewSessions.complete);

  const [showCheatSheet, setShowCheatSheet] = useState(false);

  const scope: "run" | "cycle" = data?.outputs[0]?.key.startsWith("r:")
    ? "run"
    : "cycle";

  // Rule 3: evaluators see "Evaluation — {project name}" and nothing else.
  // Authors/collaborators keep the default title.
  useEffect(() => {
    if (!data) return;
    if (data.session.role !== "evaluator") return;
    const previous = document.title;
    document.title = data.session.projectName
      ? `Evaluation — ${data.session.projectName}`
      : "Evaluation";
    return () => {
      document.title = previous;
    };
  }, [data]);

  // Global "?" shortcut to open the cheat sheet from any phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setShowCheatSheet(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fire review_session_started once per sessionId per browser session.
  const startedFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const sid = data.session.id;
    if (startedFiredRef.current === sid) return;
    startedFiredRef.current = sid;
    posthog.capture("review_session_started", {
      sessionId: sid,
      scope,
      role: data.session.role,
      output_count: data.outputs.length,
      require_phase1: data.session.requirePhase1,
      require_phase2: data.session.requirePhase2,
    });
  }, [data, scope]);

  const outputs: ReviewOutput[] = useMemo(
    () =>
      data
        ? data.outputs.map((o) => ({
            id: o.key,
            blindLabel: o.blindLabel,
            content: o.content,
            testCaseId: o.testCaseId ?? null,
          }))
        : [],
    [data],
  );

  const cardStates: Record<string, CardState> = useMemo(() => {
    if (!data) return {};
    const base = Object.fromEntries(
      data.outputs.map((o) => [
        o.key,
        {
          outputId: o.key,
          rating: null as Rating | null,
          overallNote: "",
          annotations: [] as InlineAnnotation[],
        },
      ]),
    );
    for (const r of data.ratings) {
      const cs = base[r.outputKey];
      if (cs) cs.rating = r.rating;
    }
    for (const a of data.annotations) {
      const cs = base[a.outputKey];
      if (!cs) continue;
      if (a.targetKind === "overall") {
        cs.overallNote = a.annotationData.comment;
      } else {
        cs.annotations.push({
          id: a.id,
          from: a.annotationData.from,
          to: a.annotationData.to,
          snippet: a.annotationData.highlightedText,
          comment: a.annotationData.comment,
          tags: a.tags,
        });
      }
    }
    return base;
  }, [data]);

  const matchups: Matchup[] = useMemo(
    () =>
      data
        ? data.matchups.map((m) => ({
            id: m.id,
            round: m.round,
            leftId: m.leftKey,
            rightId: m.rightKey,
            winner: m.winner,
            reasonTags: m.reasonTags as ReasonTag[],
          }))
        : [],
    [data],
  );

  const phase: Phase = data?.session.phase === "abandoned"
    ? "complete"
    : (data?.session.phase ?? "phase1");

  const splitKey = (key: string) => {
    const [kind, id] = key.split(":") as [string, string];
    return { kind, id };
  };

  const updateCard = useCallback(
    (outputId: string, patch: Partial<CardState>) => {
      if (!data) return;
      const { kind, id } = splitKey(outputId);
      if (patch.rating !== undefined && patch.rating !== null) {
        void saveRating({
          sessionId: data.session.id,
          rating: patch.rating,
          runOutputId:
            kind === "r" ? (id as Id<"runOutputs">) : undefined,
          cycleOutputId:
            kind === "c" ? (id as Id<"cycleOutputs">) : undefined,
        }).catch((err) => toast.error(friendlyError(err, "Couldn't save rating.")));
      }
      if (patch.overallNote !== undefined) {
        void saveOverallNote({
          sessionId: data.session.id,
          note: patch.overallNote,
          runOutputId:
            kind === "r" ? (id as Id<"runOutputs">) : undefined,
          cycleOutputId:
            kind === "c" ? (id as Id<"cycleOutputs">) : undefined,
        }).catch((err) => toast.error(friendlyError(err, "Couldn't save note.")));
      }
    },
    [data, saveRating, saveOverallNote],
  );

  const addAnnotationCb = useCallback(
    (outputId: string, annotation: InlineAnnotation) => {
      if (!data) return;
      const { kind, id } = splitKey(outputId);
      void addAnnotation({
        sessionId: data.session.id,
        runOutputId: kind === "r" ? (id as Id<"runOutputs">) : undefined,
        cycleOutputId:
          kind === "c" ? (id as Id<"cycleOutputs">) : undefined,
        annotationData: {
          from: annotation.from,
          to: annotation.to,
          highlightedText: annotation.snippet,
          comment: annotation.comment,
        },
        tags: annotation.tags as (
          | "accuracy"
          | "tone"
          | "length"
          | "relevance"
          | "safety"
          | "format"
          | "clarity"
          | "other"
        )[],
      }).catch((err) =>
        toast.error(friendlyError(err, "Couldn't add comment.")),
      );
    },
    [data, addAnnotation],
  );

  const removeAnnotationCb = useCallback(
    (_outputId: string, annotationId: string) => {
      if (!data) return;
      void removeAnnotation({
        sessionId: data.session.id,
        annotationId: annotationId as
          | Id<"outputFeedback">
          | Id<"cycleFeedback">,
      }).catch((err) =>
        toast.error(friendlyError(err, "Couldn't remove comment.")),
      );
    },
    [data, removeAnnotation],
  );

  const recordMatchupCb = useCallback(
    (matchupId: string, winner: Matchup["winner"], tags: ReasonTag[]) => {
      if (!data) return;
      if (winner === null) return;
      void recordMatchupMutation({
        sessionId: data.session.id,
        matchupId: matchupId as Id<"reviewMatchups">,
        winner,
        reasonTags: tags,
      })
        .then(() => {
          posthog.capture("review_phase2_matchup_recorded", {
            sessionId: data.session.id,
            scope,
            role: data.session.role,
            winner,
            reason_tag_count: tags.length,
          });
        })
        .catch((err) =>
          toast.error(friendlyError(err, "Couldn't record matchup.")),
        );
    },
    [data, recordMatchupMutation, scope],
  );

  const onSubmitPhase1 = useCallback(() => {
    if (!data) return;
    void submitPhase1({ sessionId: data.session.id })
      .then((res) => {
        posthog.capture("review_phase1_submitted", {
          sessionId: data.session.id,
          scope,
          role: data.session.role,
          output_count: data.outputs.length,
          matchups_generated: res.phase === "phase2" ? res.matchups : 0,
          advanced_to: res.phase,
        });
        if (res.phase === "complete") {
          toast.success("Review complete");
        } else {
          toast.success(`Phase 2: ${res.matchups} matchups`);
        }
      })
      .catch((err) =>
        toast.error(friendlyError(err, "Couldn't submit Phase 1.")),
      );
  }, [data, submitPhase1, scope]);

  const onFinish = useCallback(() => {
    if (!data) return;
    void complete({ sessionId: data.session.id })
      .then(() => {
        posthog.capture("review_session_completed", {
          sessionId: data.session.id,
          scope,
          role: data.session.role,
          output_count: data.outputs.length,
        });
        toast.success("Review complete");
      })
      .catch((err) => toast.error(friendlyError(err, "Couldn't complete review.")));
  }, [data, complete, scope]);

  const onNextRound = useCallback(() => {
    if (!data) return;
    void generateNextRound({ sessionId: data.session.id })
      .then((res) => {
        if ("capped" in res && res.capped) {
          toast.info("All suggested rounds completed");
        } else if (res.added === 0) {
          toast.info("No more pairings available");
        } else {
          toast.success(`Round ${res.round}: ${res.added} matchups`);
        }
      })
      .catch((err) =>
        toast.error(friendlyError(err, "Couldn't generate next round.")),
      );
  }, [data, generateNextRound]);

  if (!sessionId) {
    return <div className="p-8 text-sm">Missing session.</div>;
  }

  if (data === undefined) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  const reviewedCount = Object.values(cardStates).filter(
    (s) =>
      s.rating !== null ||
      s.overallNote.trim().length > 0 ||
      s.annotations.length > 0,
  ).length;

  const matchupsDone = matchups.filter((m) => m.winner !== null).length;
  const currentRound = data.session.currentRound ?? 0;
  const suggestedRounds = data.session.suggestedRounds ?? 1;
  const canGenerateNextRound =
    phase === "phase2" &&
    matchupsDone >= matchups.length &&
    matchups.length > 0 &&
    currentRound < suggestedRounds;
  const standings = data.standings;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <SessionHeader
        phase={phase}
        reviewedCount={reviewedCount}
        totalCount={outputs.length}
        matchupsDone={matchupsDone}
        matchupsTotal={matchups.length}
        canGenerateNextRound={canGenerateNextRound}
        onSubmitPhase1={onSubmitPhase1}
        onFinish={onFinish}
        onNextRound={onNextRound}
        onBack={() => navigate(-1)}
        onShowCheatSheet={() => setShowCheatSheet(true)}
      />

      <main className="flex-1 overflow-hidden">
        {phase === "phase1" && (
          <FlashPhase
            outputs={outputs}
            testCases={data.testCases}
            variables={data.variables}
            cardStates={cardStates}
            updateCard={updateCard}
            addAnnotation={addAnnotationCb}
            removeAnnotation={removeAnnotationCb}
          />
        )}
        {phase === "phase2" && (
          <BattlePhase
            outputs={outputs}
            matchups={matchups}
            currentRound={currentRound}
            suggestedRounds={suggestedRounds}
            recordMatchup={recordMatchupCb}
            onFinish={onFinish}
          />
        )}
        {phase === "complete" && (
          <CompleteView
            cardStates={cardStates}
            outputs={outputs}
            standings={standings}
          />
        )}
      </main>

      <CheatSheetDialog
        open={showCheatSheet}
        onOpenChange={setShowCheatSheet}
        phase={phase}
      />
    </div>
  );
}

function SessionHeader({
  phase,
  reviewedCount,
  totalCount,
  matchupsDone,
  matchupsTotal,
  canGenerateNextRound,
  onSubmitPhase1,
  onFinish,
  onNextRound,
  onBack,
  onShowCheatSheet,
}: {
  phase: Phase;
  reviewedCount: number;
  totalCount: number;
  matchupsDone: number;
  matchupsTotal: number;
  canGenerateNextRound: boolean;
  onSubmitPhase1: () => void;
  onFinish: () => void;
  onNextRound: () => void;
  onBack: () => void;
  onShowCheatSheet: () => void;
}) {
  const progressPct =
    phase === "phase1"
      ? (reviewedCount / Math.max(totalCount, 1)) * 100
      : phase === "phase2"
        ? matchupsTotal > 0
          ? (matchupsDone / matchupsTotal) * 100
          : 0
        : 100;

  return (
    <header className="relative z-20 shrink-0 border-b bg-background/80 backdrop-blur">
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back
          </button>
          <span className="text-xs text-muted-foreground">/</span>
          <span className="font-heading text-sm font-medium">Review</span>
          <PhaseChip phase={phase} />
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {phase === "phase1" && `${reviewedCount} / ${totalCount} reviewed`}
            {phase === "phase2" &&
              `${matchupsDone} / ${matchupsTotal} matchups`}
            {phase === "complete" && "Done"}
          </span>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Keyboard shortcuts"
            onClick={onShowCheatSheet}
          >
            <Keyboard className="size-4" />
          </Button>

          {phase === "phase1" && (
            <Button
              variant="default"
              size="sm"
              onClick={onSubmitPhase1}
              disabled={reviewedCount === 0}
            >
              Submit Phase 1
              <ArrowRight className="size-3.5" />
            </Button>
          )}
          {phase === "phase2" &&
            matchupsDone >= matchupsTotal &&
            matchupsTotal > 0 &&
            canGenerateNextRound && (
              <Button variant="default" size="sm" onClick={onNextRound}>
                Next round
                <ArrowRight className="size-3.5" />
              </Button>
            )}
          {phase === "phase2" && matchupsDone >= matchupsTotal && (
            <Button
              variant={canGenerateNextRound ? "outline" : "default"}
              size="sm"
              onClick={onFinish}
            >
              Finish
              <CheckCircle2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div
        className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-primary transition-[width] duration-300"
        style={{ width: `${progressPct}%` }}
        aria-hidden
      />
    </header>
  );
}

function PhaseChip({ phase }: { phase: Phase }) {
  const label = {
    phase1: "Phase 1 · Review",
    phase2: "Phase 2 · Battle",
    complete: "Complete",
  }[phase];

  return (
    <span
      className={cn(
        "hidden rounded-full border px-2 py-0.5 text-[11px] font-medium sm:inline-block",
        phase === "phase1" &&
          "border-sky-300 bg-sky-100 text-sky-700 dark:border-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
        phase === "phase2" &&
          "border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
        phase === "complete" &&
          "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
      )}
    >
      {label}
    </span>
  );
}

type Standing = {
  key: string;
  blindLabel: string;
  strength: number;
  logStrength: number;
  wins: number;
  losses: number;
  ties: number;
  battles: number;
};

function CompleteView({
  cardStates,
  outputs,
  standings,
}: {
  cardStates: Record<string, CardState>;
  outputs: ReviewOutput[];
  standings: Standing[];
}) {
  const ratings = Object.values(cardStates);
  const best = ratings.filter((s) => s.rating === "best").length;
  const acc = ratings.filter((s) => s.rating === "acceptable").length;
  const weak = ratings.filter((s) => s.rating === "weak").length;
  const notes = ratings.reduce(
    (sum, s) => sum + s.annotations.length + (s.overallNote.trim() ? 1 : 0),
    0,
  );

  const outputMap = Object.fromEntries(outputs.map((o) => [o.id, o]));
  const battled = standings.filter((s) => s.battles > 0);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Review complete</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Feedback has been saved to the session. The project author can see it
          in the feedback dashboard.
        </p>
      </div>

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">Phase 1 · ratings</h2>
        <div className="mt-2 flex gap-4 text-sm">
          <span className="text-sky-700 dark:text-sky-300">{best} best</span>
          <span className="text-slate-600 dark:text-slate-400">
            {acc} acceptable
          </span>
          <span className="text-amber-700 dark:text-amber-300">{weak} weak</span>
          <span className="text-muted-foreground">· {notes} notes</span>
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Phase 2 · standings</h2>
          <span className="text-[11px] text-muted-foreground">
            Bradley-Terry
          </span>
        </div>
        {battled.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No matchups recorded.
          </p>
        ) : (
          <ol className="mt-2 space-y-1 text-sm">
            {battled.map((s, i) => (
              <li
                key={s.key}
                className="flex items-center justify-between tabular-nums"
              >
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground">#{i + 1}</span>
                  <span className="font-medium">
                    {outputMap[s.key]?.blindLabel ?? s.blindLabel}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {s.wins}W · {s.losses}L{s.ties > 0 ? ` · ${s.ties}T` : ""}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  {s.strength.toFixed(2)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="flex gap-2">
        <Link
          to="/"
          className="inline-flex h-8 items-center rounded-lg px-2.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="mr-1.5 size-3.5" />
          Back to home
        </Link>
      </div>
    </div>
  );
}
