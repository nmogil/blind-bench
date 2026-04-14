import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { BlindLabelBadge } from "@/components/BlindLabelBadge";
import { RatingButtons, type Rating } from "@/components/RatingButtons";
import { cn } from "@/lib/utils";

type Phase = "input" | "eval" | "reveal";

const BLIND_LABELS = ["A", "B", "C"];
const MIN_OUTPUTS = 2;
const MAX_OUTPUTS = 3;

/** Fisher-Yates shuffle returning a new array. */
function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export function QuickCompare() {
  const [phase, setPhase] = useState<Phase>("input");
  const [outputs, setOutputs] = useState<string[]>(["", ""]);
  const [context, setContext] = useState("");

  // Shuffled mapping: shuffledIndices[i] = index into original outputs array
  const [shuffledIndices, setShuffledIndices] = useState<number[]>([]);
  const [ratings, setRatings] = useState<Record<string, Rating>>({});

  const activeOutputs = outputs.filter((o) => o.trim().length > 0);
  const canCompare = activeOutputs.length >= MIN_OUTPUTS;

  const shuffledOutputs = useMemo(
    () =>
      shuffledIndices.map((originalIndex, i) => ({
        label: BLIND_LABELS[i]!,
        content: outputs[originalIndex]!,
        originalIndex,
      })),
    [shuffledIndices, outputs],
  );

  function handleCompare() {
    const indices = outputs
      .map((o, i) => (o.trim() ? i : -1))
      .filter((i) => i >= 0);
    setShuffledIndices(shuffle(indices));
    setRatings({});
    setPhase("eval");
  }

  function handleRate(label: string, rating: Rating) {
    setRatings((prev) => {
      if (prev[label] === rating) {
        const next = { ...prev };
        delete next[label];
        return next;
      }
      return { ...prev, [label]: rating };
    });
  }

  function handleReveal() {
    setPhase("reveal");
  }

  function handleReset() {
    setOutputs(["", ""]);
    setContext("");
    setShuffledIndices([]);
    setRatings({});
    setPhase("input");
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Branded header */}
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-4xl items-center px-4">
          <Link to="/" className="font-semibold tracking-tight">
            Blind Bench
          </Link>
          <span className="ml-2 text-sm text-muted-foreground">
            Quick Compare
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8">
        {phase === "input" && (
          <InputPhase
            outputs={outputs}
            context={context}
            onOutputChange={(i, val) =>
              setOutputs((prev) => {
                const next = [...prev];
                next[i] = val;
                return next;
              })
            }
            onAddOutput={() => setOutputs((prev) => [...prev, ""])}
            onRemoveOutput={(i) =>
              setOutputs((prev) => prev.filter((_, idx) => idx !== i))
            }
            onContextChange={setContext}
            onCompare={handleCompare}
            canCompare={canCompare}
          />
        )}

        {phase === "eval" && (
          <EvalPhase
            outputs={shuffledOutputs}
            context={context}
            ratings={ratings}
            onRate={handleRate}
            onReveal={handleReveal}
          />
        )}

        {phase === "reveal" && (
          <RevealPhase
            outputs={shuffledOutputs}
            ratings={ratings}
            onReset={handleReset}
          />
        )}
      </main>
    </div>
  );
}

function InputPhase({
  outputs,
  context,
  onOutputChange,
  onAddOutput,
  onRemoveOutput,
  onContextChange,
  onCompare,
  canCompare,
}: {
  outputs: string[];
  context: string;
  onOutputChange: (i: number, val: string) => void;
  onAddOutput: () => void;
  onRemoveOutput: (i: number) => void;
  onContextChange: (val: string) => void;
  onCompare: () => void;
  canCompare: boolean;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Compare outputs blind
        </h1>
        <p className="mt-1 text-muted-foreground">
          Paste 2-3 LLM outputs below. We'll shuffle them so you can evaluate
          without knowing which is which.
        </p>
      </div>

      <div className="space-y-4">
        {outputs.map((output, i) => (
          <div key={i} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor={`output-${i}`}
                className="text-sm font-medium"
              >
                Output {i + 1}
              </label>
              {outputs.length > MIN_OUTPUTS && (
                <button
                  type="button"
                  onClick={() => onRemoveOutput(i)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Remove
                </button>
              )}
            </div>
            <textarea
              id={`output-${i}`}
              value={output}
              onChange={(e) => onOutputChange(i, e.target.value)}
              placeholder={`Paste output ${i + 1} here...`}
              rows={6}
              className={cn(
                "w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                "placeholder:text-muted-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "resize-y",
              )}
            />
          </div>
        ))}
      </div>

      {outputs.length < MAX_OUTPUTS && (
        <button
          type="button"
          onClick={onAddOutput}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          + Add a third output
        </button>
      )}

      <div className="space-y-1.5">
        <label htmlFor="context" className="text-sm font-medium">
          Context{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id="context"
          value={context}
          onChange={(e) => onContextChange(e.target.value)}
          placeholder="What was the prompt? This helps frame your evaluation but won't be shown during blind comparison."
          rows={2}
          className={cn(
            "w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
            "placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "resize-y",
          )}
        />
      </div>

      <button
        type="button"
        onClick={onCompare}
        disabled={!canCompare}
        className={cn(
          "rounded-md px-4 py-2 text-sm font-medium",
          canCompare
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-muted text-muted-foreground cursor-not-allowed",
        )}
      >
        Compare Blind
      </button>
    </div>
  );
}

function EvalPhase({
  outputs,
  context,
  ratings,
  onRate,
  onReveal,
}: {
  outputs: { label: string; content: string; originalIndex: number }[];
  context: string;
  ratings: Record<string, Rating>;
  onRate: (label: string, rating: Rating) => void;
  onReveal: () => void;
}) {
  const allRated = outputs.every((o) => ratings[o.label] !== undefined);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          Which output is best?
        </h2>
        <p className="mt-1 text-muted-foreground">
          Outputs have been shuffled. Rate each one without knowing the source.
        </p>
        {context && (
          <p className="mt-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Context:</span>{" "}
            {context}
          </p>
        )}
      </div>

      <div
        className={cn(
          "grid gap-4",
          outputs.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3",
        )}
      >
        {outputs.map(({ label, content }) => (
          <div
            key={label}
            className="flex flex-col gap-3 rounded-lg border border-border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <BlindLabelBadge label={label} />
              <RatingButtons
                currentRating={ratings[label] ?? null}
                onRate={(rating) => onRate(label, rating)}
              />
            </div>
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {content}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onReveal}
        disabled={!allRated}
        className={cn(
          "rounded-md px-4 py-2 text-sm font-medium",
          allRated
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-muted text-muted-foreground cursor-not-allowed",
        )}
      >
        Reveal Original Order
      </button>
    </div>
  );
}

function RevealPhase({
  outputs,
  ratings,
  onReset,
}: {
  outputs: { label: string; content: string; originalIndex: number }[];
  ratings: Record<string, Rating>;
  onReset: () => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Results</h2>
        <p className="mt-1 text-muted-foreground">
          Here's how the outputs mapped to the originals.
        </p>
      </div>

      <div className="rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-2.5 text-left font-medium">Blind Label</th>
              <th className="px-4 py-2.5 text-left font-medium">Original</th>
              <th className="px-4 py-2.5 text-left font-medium">Your Rating</th>
            </tr>
          </thead>
          <tbody>
            {outputs.map(({ label, originalIndex }) => (
              <tr key={label} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5">
                  <BlindLabelBadge label={label} />
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  Output {originalIndex + 1}
                </td>
                <td className="px-4 py-2.5 capitalize">
                  {ratings[label] ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted/50"
        >
          Try Again
        </button>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-6 text-center">
        <p className="text-sm font-medium">
          Want blind evaluation for your whole team?
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Run real LLM outputs through blind evaluation, collect annotations,
          and optimize prompts with AI feedback.
        </p>
        <Link
          to="/auth/sign-in"
          className="mt-3 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Sign up for Blind Bench
        </Link>
      </div>
    </div>
  );
}
