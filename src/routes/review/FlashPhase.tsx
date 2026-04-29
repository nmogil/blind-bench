import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  motion,
  useDragControls,
  useReducedMotion,
  type PanInfo,
} from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  MessageSquarePlus,
  StickyNote,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { RatingButtons } from "@/components/RatingButtons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { RATING_STYLES } from "@/lib/status-styles";

import {
  type CardState,
  type InlineAnnotation,
  type Rating,
  type ReviewOutput,
  REASON_TAGS,
  isCardReviewed,
} from "./types";
import {
  TestCaseContextPanel,
  type ProjectVariable,
  type TestCaseContext,
} from "./TestCaseContextPanel";

const SPRING = { type: "spring" as const, stiffness: 260, damping: 30 };

const SWIPE_DISTANCE_THRESHOLD = 100;
const SWIPE_VELOCITY_THRESHOLD = 500;

type FlashPhaseProps = {
  outputs: ReviewOutput[];
  testCases: Record<string, TestCaseContext>;
  variables: ProjectVariable[];
  cardStates: Record<string, CardState>;
  updateCard: (id: string, patch: Partial<CardState>) => void;
  addAnnotation: (id: string, annotation: InlineAnnotation) => void;
  removeAnnotation: (id: string, annotationId: string) => void;
};

export function FlashPhase({
  outputs,
  testCases,
  variables,
  cardStates,
  updateCard,
  addAnnotation,
  removeAnnotation,
}: FlashPhaseProps) {
  const [[currentIdx, direction], setState] = useState<[number, 1 | -1 | 0]>([
    0, 0,
  ]);
  const [showInputPanel, setShowInputPanel] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const current = outputs[currentIdx];
  const currentState = current ? cardStates[current.id] : undefined;
  const next = outputs[currentIdx + 1];
  const currentTestCase =
    current?.testCaseId !== null && current?.testCaseId !== undefined
      ? (testCases[current.testCaseId] ?? null)
      : null;

  const goNext = useCallback(() => {
    setState(([i]) => [Math.min(i + 1, outputs.length - 1), 1]);
  }, [outputs.length]);
  const goPrev = useCallback(() => {
    setState(([i]) => [Math.max(i - 1, 0), -1]);
  }, []);
  const goTo = useCallback(
    (idx: number) => {
      setState(([i]) => [idx, idx > i ? 1 : -1]);
    },
    [],
  );

  const setRating = useCallback(
    (r: Rating) => {
      if (!current) return;
      const prevRating = cardStates[current.id]?.rating ?? null;
      const id = current.id;
      updateCard(id, { rating: r });
      toast(`Rated ${RATING_STYLES[r].icon.name ?? r}`, {
        action: prevRating !== r
          ? {
              label: "Undo",
              onClick: () => updateCard(id, { rating: prevRating }),
            }
          : undefined,
      });
    },
    [current, cardStates, updateCard],
  );

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Suppress when editable element has focus
      const target = e.target as HTMLElement | null;
      const editableFocused =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA";

      if (editableFocused) {
        if (e.key === "Escape") {
          (target as HTMLElement).blur();
          e.preventDefault();
        }
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "1") {
        e.preventDefault();
        setRating("weak");
      } else if (e.key === "2") {
        e.preventDefault();
        setRating("acceptable");
      } else if (e.key === "3") {
        e.preventDefault();
        setRating("best");
      } else if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        noteRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, setRating]);

  if (!current) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No outputs to review.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col md:grid md:grid-cols-[minmax(180px,220px)_1fr_minmax(280px,340px)]">
      {/* LEFT: filmstrip (desktop only) */}
      <aside className="hidden border-r bg-muted/30 p-3 md:block md:overflow-y-auto">
        <FilmstripDesktop
          outputs={outputs}
          cardStates={cardStates}
          currentIdx={currentIdx}
          onSelect={goTo}
        />
        <button
          type="button"
          onClick={() => setShowInputPanel((v) => !v)}
          className="mt-3 w-full rounded-md border border-dashed px-2 py-2 text-left text-xs text-muted-foreground hover:bg-background"
        >
          {showInputPanel ? "Hide" : "Show"} test case
        </button>
        {showInputPanel && (
          <TestCaseContextPanel
            testCase={currentTestCase}
            variables={variables}
            className="mt-2"
          />
        )}
      </aside>

      {/* CENTER: deck stage */}
      <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden md:flex-none">
        {/* Mobile: top filmstrip */}
        <div className="shrink-0 border-b px-3 py-2 md:hidden">
          <FilmstripMobile
            outputs={outputs}
            cardStates={cardStates}
            currentIdx={currentIdx}
            onSelect={goTo}
          />
        </div>

        <div className="relative flex flex-1 items-center justify-center px-3 py-4 sm:p-6 md:p-8">
          <DeckStage
            current={current}
            currentState={currentState}
            next={next}
            direction={direction}
            onNext={goNext}
            onPrev={goPrev}
            onAddAnnotation={(a) => {
              addAnnotation(current.id, a);
              toast.success("Comment added", {
                action: {
                  label: "Undo",
                  onClick: () => removeAnnotation(current.id, a.id),
                },
              });
            }}
            onRemoveAnnotation={(id) => removeAnnotation(current.id, id)}
          />
        </div>

        {/* Rating + nav row */}
        <div className="shrink-0 border-t bg-background/60 px-3 py-3 backdrop-blur sm:px-6">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={goPrev}
              disabled={currentIdx === 0}
              aria-label="Previous output"
            >
              <ArrowLeft className="size-4" />
            </Button>

            <div className="flex flex-col items-center gap-1">
              <RatingButtons
                currentRating={currentState?.rating ?? null}
                onRate={setRating}
              />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                keys: 1 weak · 2 accept · 3 best
              </span>
            </div>

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={goNext}
              disabled={currentIdx === outputs.length - 1}
              aria-label="Next output"
            >
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      </section>

      {/* RIGHT: overall note + annotations (desktop) / Bottom drawer (mobile) */}
      <aside className="hidden border-l md:flex md:flex-col md:overflow-hidden">
        <OverallNotePanel
          output={current}
          state={currentState}
          noteRef={noteRef}
          onChangeNote={(text) => updateCard(current.id, { overallNote: text })}
          onRemoveAnnotation={(id) => removeAnnotation(current.id, id)}
        />
      </aside>

      {/* Mobile: bottom drawer handle */}
      <MobileNoteSheet
        output={current}
        state={currentState}
        noteRef={noteRef}
        onChangeNote={(text) => updateCard(current.id, { overallNote: text })}
        onRemoveAnnotation={(id) => removeAnnotation(current.id, id)}
        reviewed={isCardReviewed(currentState)}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------

type DeckStageProps = {
  current: ReviewOutput;
  currentState: CardState | undefined;
  next: ReviewOutput | undefined;
  direction: 1 | -1 | 0;
  onNext: () => void;
  onPrev: () => void;
  onAddAnnotation: (a: InlineAnnotation) => void;
  onRemoveAnnotation: (id: string) => void;
};

function DeckStage({
  current,
  currentState,
  next,
  direction,
  onNext,
  onPrev,
  onAddAnnotation,
  onRemoveAnnotation,
}: DeckStageProps) {
  const reducedMotion = useReducedMotion();
  const dragControls = useDragControls();

  const variants = reducedMotion
    ? {
        enter: { opacity: 0 },
        center: { opacity: 1 },
        exit: { opacity: 0 },
      }
    : {
        enter: (d: number) => ({
          x: d > 0 ? "60%" : "-60%",
          rotate: d > 0 ? 4 : -4,
          opacity: 0,
          scale: 0.96,
        }),
        center: { x: 0, rotate: 0, opacity: 1, scale: 1 },
        exit: (d: number) => ({
          x: d > 0 ? "-60%" : "60%",
          rotate: d > 0 ? -4 : 4,
          opacity: 0,
          scale: 0.96,
        }),
      };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (
      info.offset.x < -SWIPE_DISTANCE_THRESHOLD ||
      info.velocity.x < -SWIPE_VELOCITY_THRESHOLD
    ) {
      onNext();
    } else if (
      info.offset.x > SWIPE_DISTANCE_THRESHOLD ||
      info.velocity.x > SWIPE_VELOCITY_THRESHOLD
    ) {
      onPrev();
    }
  };

  return (
    <div className="relative h-full w-full max-w-2xl">
      {/* Peek next (static, non-interactive) */}
      {next && (
        <div
          className="pointer-events-none absolute inset-0 flex items-stretch"
          style={{
            transform: reducedMotion
              ? undefined
              : "translateY(12px) scale(0.96)",
            opacity: reducedMotion ? 0 : 0.5,
          }}
        >
          <CardShell peek>
            <div className="px-5 py-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {next.blindLabel}
              </div>
            </div>
          </CardShell>
        </div>
      )}

      {/* Current draggable card */}
      <AnimatePresence initial={false} custom={direction} mode="popLayout">
        <motion.div
          key={current.id}
          className="absolute inset-0"
          custom={direction}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={reducedMotion ? { duration: 0.14 } : SPRING}
          drag={reducedMotion ? false : "x"}
          dragControls={dragControls}
          dragListener={false}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.2}
          onDragEnd={onDragEnd}
          style={{ touchAction: "pan-y" }}
          whileDrag={{ cursor: "grabbing" }}
        >
          <FlashCard
            output={current}
            state={currentState}
            onAddAnnotation={onAddAnnotation}
            onRemoveAnnotation={onRemoveAnnotation}
            onDragHandlePointerDown={
              reducedMotion
                ? undefined
                : (e) => dragControls.start(e)
            }
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ----------------------------------------------------------------------------

function CardShell({
  children,
  peek,
}: {
  children: ReactNode;
  peek?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-2xl border bg-card text-card-foreground shadow-sm",
        peek && "shadow-none",
      )}
    >
      {children}
    </div>
  );
}

function FlashCard({
  output,
  state,
  onAddAnnotation,
  onRemoveAnnotation,
  onDragHandlePointerDown,
}: {
  output: ReviewOutput;
  state: CardState | undefined;
  onAddAnnotation: (a: InlineAnnotation) => void;
  onRemoveAnnotation: (id: string) => void;
  onDragHandlePointerDown?: (e: ReactPointerEvent) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    snippet: string;
    rect: DOMRect;
  } | null>(null);
  const [composing, setComposing] = useState<{
    snippet: string;
    rect: DOMRect;
  } | null>(null);

  // Detect text selection in the card body
  useEffect(() => {
    function onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !bodyRef.current) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!bodyRef.current.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const snippet = sel.toString().trim();
      if (!snippet) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelection({ snippet, rect });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const annotations = state?.annotations ?? [];
  const rating = state?.rating;

  const renderedContent = useMemo(
    () => renderWithHighlights(output.content, annotations),
    [output.content, annotations],
  );

  return (
    <CardShell>
      {/* Chrome header — drag zone (keeps body free for text selection) */}
      <div
        className="flex shrink-0 cursor-grab items-center justify-between border-b px-5 py-3 active:cursor-grabbing"
        onPointerDown={onDragHandlePointerDown}
        style={{ touchAction: "pan-y" }}
      >
        <div className="flex items-center gap-2">
          <span className="font-heading text-sm font-medium">
            {output.blindLabel}
          </span>
          {rating && <RatingDot rating={rating} />}
        </div>
        <div className="flex items-center gap-2">
          {annotations.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              <MessageSquarePlus className="size-3" />
              {annotations.length}
            </span>
          )}
        </div>
      </div>

      {/* Body — free for text selection; drag is isolated to the header handle */}
      <div
        ref={bodyRef}
        className="relative flex-1 overflow-y-auto px-5 py-4 leading-relaxed selection:bg-sky-200/60"
      >
        {renderedContent}
      </div>

      {/* Inline annotation list */}
      {annotations.length > 0 && (
        <div className="max-h-28 shrink-0 overflow-y-auto border-t bg-muted/40 px-5 py-2">
          <ul className="space-y-1.5 text-xs">
            {annotations.map((a) => (
              <li key={a.id} className="flex items-start gap-2">
                <span className="mt-0.5 inline-block size-1.5 shrink-0 rounded-full bg-sky-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-muted-foreground">
                    “{a.snippet}”
                  </div>
                  <div className="text-foreground">{a.comment}</div>
                </div>
                <button
                  onClick={() => onRemoveAnnotation(a.id)}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Remove comment"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Selection bubble */}
      {selection && !composing && (
        <SelectionBubble
          rect={selection.rect}
          onClick={() => {
            setComposing(selection);
            setSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}

      {/* Compose popover */}
      {composing && (
        <CommentComposer
          snippet={composing.snippet}
          rect={composing.rect}
          onSave={(comment, tags) => {
            onAddAnnotation({
              id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              from: 0,
              to: 0,
              snippet: composing.snippet,
              comment,
              tags,
            });
            setComposing(null);
          }}
          onCancel={() => setComposing(null)}
        />
      )}
    </CardShell>
  );
}

function RatingDot({ rating }: { rating: Rating }) {
  const color = {
    best: "bg-sky-500",
    acceptable: "bg-slate-400",
    weak: "bg-amber-500",
  }[rating];
  return <span className={cn("inline-block size-2 rounded-full", color)} />;
}

// ----------------------------------------------------------------------------
// Inline highlight rendering

function renderWithHighlights(
  content: string,
  annotations: InlineAnnotation[],
): ReactNode {
  if (annotations.length === 0) return content;

  // Build a set of character ranges based on string search (first occurrence).
  const ranges: { start: number; end: number; annId: string }[] = [];
  for (const ann of annotations) {
    const start = content.indexOf(ann.snippet);
    if (start >= 0) {
      ranges.push({
        start,
        end: start + ann.snippet.length,
        annId: ann.id,
      });
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue; // skip overlap
    if (r.start > cursor) {
      nodes.push(content.slice(cursor, r.start));
    }
    nodes.push(
      <mark
        key={r.annId}
        className="rounded bg-sky-200/60 px-0.5 dark:bg-sky-500/30"
      >
        {content.slice(r.start, r.end)}
      </mark>,
    );
    cursor = r.end;
  }
  if (cursor < content.length) {
    nodes.push(content.slice(cursor));
  }
  return nodes;
}

// ----------------------------------------------------------------------------
// Selection bubble + comment composer

function SelectionBubble({
  rect,
  onClick,
}: {
  rect: DOMRect;
  onClick: () => void;
}) {
  const top = rect.top - 40;
  const left = rect.left + rect.width / 2 - 70;
  return createPortal(
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="fixed z-40"
      style={{ top, left }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Button variant="default" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
        <MessageSquarePlus className="size-3.5" />
        Comment
      </Button>
    </motion.div>,
    document.body,
  );
}

function CommentComposer({
  snippet,
  rect,
  onSave,
  onCancel,
}: {
  snippet: string;
  rect: DOMRect;
  onSave: (comment: string, tags: string[]) => void;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const top = Math.min(rect.bottom + 8, window.innerHeight - 260);
  const left = Math.max(
    8,
    Math.min(rect.left, window.innerWidth - 320),
  );

  return createPortal(
    <div
      className="fixed z-50 w-[300px] rounded-lg border bg-popover p-3 text-sm shadow-lg ring-1 ring-foreground/10"
      style={{ top, left }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 rounded border-l-2 border-sky-400 bg-muted/60 px-2 py-1 text-xs italic text-muted-foreground">
        “{snippet}”
      </div>
      <Textarea
        ref={ref}
        placeholder="What about this part?"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="min-h-20 text-sm"
      />
      <div className="mt-2 flex flex-wrap gap-1">
        {REASON_TAGS.map((t) => {
          const active = tags.includes(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() =>
                setTags((prev) =>
                  active ? prev.filter((x) => x !== t) : [...prev, t],
                )
              }
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                active
                  ? "border-sky-400 bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {t}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onSave(comment.trim(), tags)}
          disabled={!comment.trim()}
        >
          Save
        </Button>
      </div>
    </div>,
    document.body,
  );
}

// ----------------------------------------------------------------------------
// Filmstrips

function FilmstripDesktop({
  outputs,
  cardStates,
  currentIdx,
  onSelect,
}: {
  outputs: ReviewOutput[];
  cardStates: Record<string, CardState>;
  currentIdx: number;
  onSelect: (idx: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Outputs ({outputs.length})
      </div>
      {outputs.map((o, i) => {
        const state = cardStates[o.id];
        const reviewed = isCardReviewed(state);
        const active = i === currentIdx;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onSelect(i)}
            className={cn(
              "group flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
              active
                ? "border-primary bg-primary/5"
                : "border-transparent hover:bg-background",
            )}
          >
            <span className="w-6 shrink-0 tabular-nums text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="flex-1 truncate font-medium">{o.blindLabel}</span>
            {state?.rating && <RatingDot rating={state.rating} />}
            {!state?.rating && reviewed && (
              <StickyNote className="size-3 text-muted-foreground" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function FilmstripMobile({
  outputs,
  cardStates,
  currentIdx,
  onSelect,
}: {
  outputs: ReviewOutput[];
  cardStates: Record<string, CardState>;
  currentIdx: number;
  onSelect: (idx: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {currentIdx + 1}/{outputs.length}
      </span>
      <div className="flex items-center gap-1">
        {outputs.map((o, i) => {
          const state = cardStates[o.id];
          const active = i === currentIdx;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onSelect(i)}
              aria-label={`Go to ${o.blindLabel}`}
              className={cn(
                "h-1.5 shrink-0 rounded-full transition-all",
                active ? "w-6 bg-primary" : "w-3 bg-muted-foreground/30",
                state?.rating === "best" && !active && "bg-sky-400",
                state?.rating === "acceptable" && !active && "bg-slate-400",
                state?.rating === "weak" && !active && "bg-amber-400",
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Overall-note panel (desktop sidebar)

function OverallNotePanel({
  output,
  state,
  noteRef,
  onChangeNote,
  onRemoveAnnotation,
}: {
  output: ReviewOutput;
  state: CardState | undefined;
  noteRef: React.RefObject<HTMLTextAreaElement | null>;
  onChangeNote: (text: string) => void;
  onRemoveAnnotation: (id: string) => void;
}) {
  const annotations = state?.annotations ?? [];
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Notes on {output.blindLabel}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <label className="text-xs font-medium">Overall note</label>
        <Textarea
          ref={noteRef}
          placeholder="What stood out? (C to focus)"
          value={state?.overallNote ?? ""}
          onChange={(e) => onChangeNote(e.target.value)}
          className="mt-1 min-h-24"
        />

        <div className="mt-4 text-xs font-medium">
          Inline comments ({annotations.length})
        </div>
        {annotations.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Select text on the card to add one.
          </p>
        ) : (
          <ul className="mt-2 space-y-2 text-xs">
            {annotations.map((a) => (
              <li
                key={a.id}
                className="group rounded-md border bg-card p-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate italic text-muted-foreground">
                      “{a.snippet}”
                    </div>
                    <div className="mt-0.5">{a.comment}</div>
                    {a.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {a.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => onRemoveAnnotation(a.id)}
                    className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    aria-label="Remove"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Mobile bottom sheet for note

function MobileNoteSheet({
  output,
  state,
  noteRef,
  onChangeNote,
  onRemoveAnnotation,
  reviewed,
}: {
  output: ReviewOutput;
  state: CardState | undefined;
  noteRef: React.RefObject<HTMLTextAreaElement | null>;
  onChangeNote: (text: string) => void;
  onRemoveAnnotation: (id: string) => void;
  reviewed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const annotations = state?.annotations ?? [];
  const hasContent = (state?.overallNote ?? "").length > 0 || annotations.length > 0;

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center justify-between border-t bg-muted/40 px-4 py-2 text-xs",
          hasContent && "bg-sky-50 dark:bg-sky-950/20",
        )}
      >
        <span className="flex items-center gap-2">
          <StickyNote className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">
            {hasContent
              ? `Notes on ${output.blindLabel}`
              : `Add notes on ${output.blindLabel}`}
          </span>
        </span>
        <span className="text-muted-foreground">
          {state?.overallNote ? "✓ note" : ""}
          {state?.overallNote && annotations.length > 0 ? " · " : ""}
          {annotations.length > 0 ? `${annotations.length} inline` : ""}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/30"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.div
              className="fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t bg-background p-4 shadow-2xl"
              initial={reducedMotion ? { opacity: 0 } : { y: "100%" }}
              animate={reducedMotion ? { opacity: 1 } : { y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { y: "100%" }}
              transition={reducedMotion ? { duration: 0.14 } : SPRING}
              drag={reducedMotion ? false : "y"}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={0.2}
              onDragEnd={(_, info) => {
                if (info.offset.y > 120 || info.velocity.y > 500) {
                  setOpen(false);
                }
              }}
            >
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
              <OverallNotePanel
                output={output}
                state={state}
                noteRef={noteRef}
                onChangeNote={onChangeNote}
                onRemoveAnnotation={onRemoveAnnotation}
              />
              {reviewed && (
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpen(false)}
                  >
                    <Undo2 className="size-3.5" />
                    Close
                  </Button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
