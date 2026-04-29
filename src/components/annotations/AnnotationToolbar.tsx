import { useEffect, useRef, useState } from "react";
import { GripVertical, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { LabelPicker } from "./LabelPicker";
import {
  DEFAULT_ANNOTATION_LABEL,
  type AnnotationLabel,
} from "./labels";
import { useDraggable } from "./useDraggable";

export interface AnnotationDraft {
  highlightedText: string;
  /** Viewport-space anchor for the floating toolbar (typically end of selection rect). */
  anchor?: { x: number; y: number };
}

interface AnnotationToolbarProps {
  /** When non-null, the toolbar is open. Set to null to close. */
  draft: AnnotationDraft | null;
  onSubmit: (label: AnnotationLabel, comment: string) => void;
  onClose: () => void;
}

/**
 * Floating, draggable comment surface for the eval grid (M27.3).
 *
 * Falls back to a bottom-sheet on touch / narrow viewports — the floating
 * toolbar is desktop-only because dragging is a power-user affordance.
 *
 * Position is session-scoped state (not persisted to localStorage). On open
 * the toolbar prefers the selection's trailing-end anchor; if dragged, the
 * dragged position holds for the rest of the session.
 *
 * Blind-eval rule: zero data-version-id / data-run-id / version-id / run-id
 * attributes appear in the rendered DOM. The submit handler is opaque-token
 * scoped at the call site (this component does not call any mutation directly).
 */
export function AnnotationToolbar({
  draft,
  onSubmit,
  onClose,
}: AnnotationToolbarProps) {
  const [comment, setComment] = useState("");
  const [label, setLabel] = useState<AnnotationLabel>(DEFAULT_ANNOTATION_LABEL);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isTouch, setIsTouch] = useState(false);

  // Detect touch / narrow viewports. Re-evaluates on resize.
  useEffect(() => {
    const update = () => {
      setIsTouch(
        typeof window !== "undefined" &&
          (window.matchMedia("(pointer: coarse)").matches ||
            window.innerWidth < 768),
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const { position, setPosition, handleProps } = useDraggable({
    initial: { x: 24, y: 96 },
    disabled: isTouch,
  });

  // Re-anchor when a new draft opens, unless the user has dragged this session.
  const anchoredRef = useRef(false);
  useEffect(() => {
    if (!draft || isTouch) return;
    if (!draft.anchor) return;
    if (anchoredRef.current) return;
    const x = Math.max(8, Math.min(window.innerWidth - 320, draft.anchor.x));
    const y = Math.max(8, Math.min(window.innerHeight - 240, draft.anchor.y));
    setPosition({ x, y });
    anchoredRef.current = true;
  }, [draft, isTouch, setPosition]);

  // Reset on open
  useEffect(() => {
    if (draft) {
      setComment("");
      setLabel(DEFAULT_ANNOTATION_LABEL);
      setTimeout(() => textareaRef.current?.focus(), 0);
    } else {
      anchoredRef.current = false;
    }
  }, [draft]);

  // Esc closes; Cmd/Ctrl+Enter submits — handled at the textarea level
  // because the toolbar is a focused surface.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (comment.trim()) onSubmit(label, comment.trim());
    }
  };

  if (!draft) return null;

  // Touch / narrow viewports: bottom sheet (custom — the Sheet primitive slides
  // from the right; we want a bottom-anchored modal here).
  if (isTouch) {
    return (
      <div className="fixed inset-0 z-50" role="dialog" aria-label="Add comment">
        {/* Backdrop */}
        <button
          type="button"
          aria-label="Close"
          className="absolute inset-0 bg-black/30"
          onClick={onClose}
        />
        {/* Sheet */}
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto",
            "rounded-t-xl border-t bg-popover p-4 shadow-2xl",
            "motion-safe:animate-in motion-safe:slide-in-from-bottom",
          )}
        >
          <h2 className="text-sm font-semibold mb-3">Add comment</h2>
          <div className="space-y-3">
            <blockquote className="border-l-2 border-primary/50 pl-2 text-xs text-muted-foreground italic">
              {draft.highlightedText}
            </blockquote>
            <LabelPicker value={label} onChange={setLabel} />
            <Textarea
              ref={textareaRef}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Leave a comment…"
              className="min-h-[100px] text-sm"
              onKeyDown={handleKeyDown}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  comment.trim() && onSubmit(label, comment.trim())
                }
                disabled={!comment.trim()}
              >
                Submit
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Desktop: floating draggable toolbar
  return (
    <div
      data-draggable-root
      role="dialog"
      aria-label="Add comment"
      className={cn(
        "fixed z-50 w-[320px] rounded-lg border bg-popover shadow-xl",
        "motion-safe:transition-shadow",
      )}
      style={{ left: position.x, top: position.y }}
    >
      {/* Header — drag handle */}
      <div
        {...handleProps}
        role="button"
        tabIndex={0}
        aria-label="Drag toolbar"
        className="flex items-center justify-between px-2 border-b h-[var(--panel-header-h)] select-none"
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
          <span>Comment</span>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      {/* Body */}
      <div className="p-3 space-y-2">
        <blockquote className="border-l-2 border-primary/50 pl-2 text-xs text-muted-foreground italic max-h-16 overflow-y-auto">
          {draft.highlightedText}
        </blockquote>
        <LabelPicker
          value={label}
          onChange={setLabel}
          variant="compact"
        />
        <Textarea
          ref={textareaRef}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Leave a comment…"
          className="min-h-[80px] text-sm"
          onKeyDown={handleKeyDown}
        />
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-muted-foreground">
            {"⌘"}Enter to submit · Esc to close
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => comment.trim() && onSubmit(label, comment.trim())}
              disabled={!comment.trim()}
            >
              Submit
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
