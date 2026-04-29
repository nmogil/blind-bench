import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, Keyboard, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { FlashPhase } from "./FlashPhase";
import { BattlePhase } from "./BattlePhase";
import { CheatSheetDialog } from "./CheatSheetDialog";
import { MOCK_OUTPUTS, generateRoundRobinMatchups } from "./mockData";
import {
  type CardState,
  type InlineAnnotation,
  type Matchup,
  type Phase,
  type Rating,
  type ReasonTag,
  isCardReviewed,
} from "./types";

function makeInitialStates(): Record<string, CardState> {
  return Object.fromEntries(
    MOCK_OUTPUTS.map((o) => [
      o.id,
      {
        outputId: o.id,
        rating: null as Rating | null,
        overallNote: "",
        annotations: [] as InlineAnnotation[],
      },
    ]),
  );
}

export function DemoDeck() {
  const [phase, setPhase] = useState<Phase>("phase1");
  const [cardStates, setCardStates] =
    useState<Record<string, CardState>>(makeInitialStates);
  const [matchups, setMatchups] = useState<Matchup[]>([]);
  const [showCheatSheet, setShowCheatSheet] = useState(false);

  const reviewedCount = useMemo(
    () => Object.values(cardStates).filter(isCardReviewed).length,
    [cardStates],
  );

  const updateCard = useCallback(
    (outputId: string, patch: Partial<CardState>) => {
      setCardStates((prev) => {
        const existing = prev[outputId];
        if (!existing) return prev;
        return { ...prev, [outputId]: { ...existing, ...patch } };
      });
    },
    [],
  );

  const addAnnotation = useCallback(
    (outputId: string, annotation: InlineAnnotation) => {
      setCardStates((prev) => {
        const existing = prev[outputId];
        if (!existing) return prev;
        return {
          ...prev,
          [outputId]: {
            ...existing,
            annotations: [...existing.annotations, annotation],
          },
        };
      });
    },
    [],
  );

  const removeAnnotation = useCallback(
    (outputId: string, annotationId: string) => {
      setCardStates((prev) => {
        const existing = prev[outputId];
        if (!existing) return prev;
        return {
          ...prev,
          [outputId]: {
            ...existing,
            annotations: existing.annotations.filter(
              (a) => a.id !== annotationId,
            ),
          },
        };
      });
    },
    [],
  );

  const startPhase2 = useCallback(() => {
    // Drop "weak"-rated outputs from the bracket; everything else competes.
    const dropped = new Set(
      Object.values(cardStates)
        .filter((s) => s.rating === "weak")
        .map((s) => s.outputId),
    );
    const pairs = generateRoundRobinMatchups(MOCK_OUTPUTS, dropped);
    if (pairs.length < 1) {
      toast.error("Need at least 2 non-weak outputs to battle.");
      return;
    }
    setMatchups(
      pairs.map((p, i) => ({
        id: `m-${i}`,
        round: 1,
        leftId: p.leftId,
        rightId: p.rightId,
        winner: null,
        reasonTags: [],
      })),
    );
    setPhase("phase2");
  }, [cardStates]);

  const recordMatchup = useCallback(
    (matchupId: string, winner: Matchup["winner"], tags: ReasonTag[]) => {
      setMatchups((prev) =>
        prev.map((m) =>
          m.id === matchupId ? { ...m, winner, reasonTags: tags } : m,
        ),
      );
    },
    [],
  );

  const resetAll = useCallback(() => {
    setPhase("phase1");
    setCardStates(makeInitialStates());
    setMatchups([]);
    toast.success("Reset.");
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <DemoHeader
        phase={phase}
        reviewedCount={reviewedCount}
        totalCount={MOCK_OUTPUTS.length}
        matchupsDone={matchups.filter((m) => m.winner !== null).length}
        matchupsTotal={matchups.length}
        onSubmitPhase1={startPhase2}
        onFinish={() => setPhase("complete")}
        onReset={resetAll}
        onShowCheatSheet={() => setShowCheatSheet(true)}
      />

      <main className="flex-1 overflow-hidden">
        {phase === "phase1" && (
          <FlashPhase
            outputs={MOCK_OUTPUTS}
            testCases={{}}
            variables={[]}
            cardStates={cardStates}
            updateCard={updateCard}
            addAnnotation={addAnnotation}
            removeAnnotation={removeAnnotation}
          />
        )}
        {phase === "phase2" && (
          <BattlePhase
            outputs={MOCK_OUTPUTS}
            matchups={matchups}
            currentRound={1}
            suggestedRounds={1}
            recordMatchup={recordMatchup}
            onFinish={() => setPhase("complete")}
          />
        )}
        {phase === "complete" && (
          <CompletePhase
            cardStates={cardStates}
            matchups={matchups}
            onReset={resetAll}
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

function DemoHeader({
  phase,
  reviewedCount,
  totalCount,
  matchupsDone,
  matchupsTotal,
  onSubmitPhase1,
  onFinish,
  onReset,
  onShowCheatSheet,
}: {
  phase: Phase;
  reviewedCount: number;
  totalCount: number;
  matchupsDone: number;
  matchupsTotal: number;
  onSubmitPhase1: () => void;
  onFinish: () => void;
  onReset: () => void;
  onShowCheatSheet: () => void;
}) {
  const progressPct =
    phase === "phase1"
      ? (reviewedCount / totalCount) * 100
      : phase === "phase2"
        ? matchupsTotal > 0
          ? (matchupsDone / matchupsTotal) * 100
          : 0
        : 100;

  return (
    <header className="relative z-20 shrink-0 border-b bg-background/80 backdrop-blur">
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Home
          </Link>
          <span className="text-xs text-muted-foreground">/</span>
          <span className="font-heading text-sm font-medium">Review demo</span>
          <PhaseChip phase={phase} />
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {phase === "phase1" &&
              `${reviewedCount} / ${totalCount} reviewed`}
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

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reset"
            onClick={onReset}
          >
            <RotateCcw className="size-4" />
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
          {phase === "phase2" && matchupsDone >= matchupsTotal && (
            <Button variant="default" size="sm" onClick={onFinish}>
              Finish
              <CheckCircle2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
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

function CompletePhase({
  cardStates,
  matchups,
  onReset,
}: {
  cardStates: Record<string, CardState>;
  matchups: Matchup[];
  onReset: () => void;
}) {
  const ratings = Object.values(cardStates);
  const best = ratings.filter((s) => s.rating === "best").length;
  const acc = ratings.filter((s) => s.rating === "acceptable").length;
  const weak = ratings.filter((s) => s.rating === "weak").length;
  const comments = ratings.reduce(
    (sum, s) => sum + s.annotations.length + (s.overallNote.trim() ? 1 : 0),
    0,
  );

  const winCounts: Record<string, number> = {};
  for (const m of matchups) {
    if (m.winner === "left") winCounts[m.leftId] = (winCounts[m.leftId] ?? 0) + 1;
    if (m.winner === "right")
      winCounts[m.rightId] = (winCounts[m.rightId] ?? 0) + 1;
    if (m.winner === "tie") {
      winCounts[m.leftId] = (winCounts[m.leftId] ?? 0) + 0.5;
      winCounts[m.rightId] = (winCounts[m.rightId] ?? 0) + 0.5;
    }
  }
  const leaderboard = Object.entries(winCounts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Review complete</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This is prototype output — in production, these signals would feed
          the optimizer.
        </p>
      </div>

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">Phase 1 · ratings</h2>
        <div className="mt-2 flex gap-4 text-sm">
          <span className="text-sky-700 dark:text-sky-300">{best} best</span>
          <span className="text-slate-600 dark:text-slate-400">{acc} acceptable</span>
          <span className="text-amber-700 dark:text-amber-300">{weak} weak</span>
          <span className="text-muted-foreground">· {comments} notes</span>
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">Phase 2 · leaderboard</h2>
        {leaderboard.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No matchups recorded.
          </p>
        ) : (
          <ol className="mt-2 space-y-1 text-sm">
            {leaderboard.map(([id, wins], i) => {
              const out = MOCK_OUTPUTS.find((o) => o.id === id);
              return (
                <li
                  key={id}
                  className="flex items-center justify-between tabular-nums"
                >
                  <span>
                    <span className="mr-2 text-muted-foreground">#{i + 1}</span>
                    {out?.blindLabel}
                  </span>
                  <span className="text-muted-foreground">{wins} pts</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <div className="flex gap-2">
        <Button variant="outline" onClick={onReset}>
          <RotateCcw className="size-3.5" />
          Run again
        </Button>
        <Link
          to="/"
          className="inline-flex h-8 items-center rounded-lg px-2.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
