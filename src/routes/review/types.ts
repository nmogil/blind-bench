import type { Rating } from "@/lib/status-styles";

export type { Rating };

export type ReviewOutput = {
  id: string;
  blindLabel: string;
  content: string;
  testCaseId: string | null;
};

export type InlineAnnotation = {
  id: string;
  from: number;
  to: number;
  snippet: string;
  comment: string;
  tags: string[];
};

export type CardState = {
  outputId: string;
  rating: Rating | null;
  overallNote: string;
  annotations: InlineAnnotation[];
};

export type Matchup = {
  id: string;
  round: number;
  leftId: string;
  rightId: string;
  winner: "left" | "right" | "tie" | "skip" | null;
  reasonTags: string[];
};

export type Phase = "phase1" | "phase2" | "complete";

export const REASON_TAGS = [
  "tone",
  "accuracy",
  "clarity",
  "length",
  "format",
  "relevance",
  "safety",
  "other",
] as const;

export type ReasonTag = (typeof REASON_TAGS)[number];

export function isCardReviewed(state: CardState | undefined): boolean {
  if (!state) return false;
  return (
    state.rating !== null ||
    state.overallNote.trim().length > 0 ||
    state.annotations.length > 0
  );
}
