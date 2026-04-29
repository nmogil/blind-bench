import { useCallback, useEffect, useRef, useState } from "react";

interface DraggableOptions {
  /** Initial position (top-left origin within viewport). */
  initial?: { x: number; y: number };
  /** Margin from viewport edges. */
  margin?: number;
  /** Disabled flag — drag is no-op. Used on touch / narrow viewports. */
  disabled?: boolean;
}

interface DraggableState {
  position: { x: number; y: number };
  setPosition: (p: { x: number; y: number }) => void;
  isDragging: boolean;
  /** Bind to the drag handle element via {...handleProps}. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    style: React.CSSProperties;
  };
}

/**
 * Pointer-based drag for an absolutely-positioned floating element.
 *
 * Constrains the position so the element cannot leave the viewport (relies on
 * the consumer to also expose width/height to clamp against — falls back to
 * the dragged element's own bounding rect if no size is passed).
 *
 * Pointer events handle mouse + pen + touch uniformly. When `disabled`, the
 * handle becomes inert; consumers should also fall back to a non-floating UI
 * (e.g. a bottom-sheet modal) on touch.
 */
export function useDraggable({
  initial,
  margin = 8,
  disabled = false,
}: DraggableOptions = {}): DraggableState {
  const [position, setPositionState] = useState(
    () => initial ?? { x: 24, y: 24 },
  );
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    el: HTMLElement;
  } | null>(null);

  const setPosition = useCallback((p: { x: number; y: number }) => {
    setPositionState(p);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      // Only respond to primary button or touch.
      if (e.button !== 0 && e.pointerType !== "touch" && e.pointerType !== "pen")
        return;
      const target = e.currentTarget as HTMLElement;
      const root = target.closest<HTMLElement>("[data-draggable-root]") ?? target;
      const rect = root.getBoundingClientRect();
      draggingRef.current = {
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        el: root,
      };
      target.setPointerCapture(e.pointerId);
      setIsDragging(true);
    },
    [disabled],
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const rect = drag.el.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const maxX = window.innerWidth - w - margin;
      const maxY = window.innerHeight - h - margin;
      const nextX = Math.max(margin, Math.min(maxX, e.clientX - drag.offsetX));
      const nextY = Math.max(margin, Math.min(maxY, e.clientY - drag.offsetY));
      setPositionState({ x: nextX, y: nextY });
    };

    const onUp = (e: PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      draggingRef.current = null;
      setIsDragging(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [isDragging, margin]);

  return {
    position,
    setPosition,
    isDragging,
    handleProps: {
      onPointerDown,
      style: { cursor: disabled ? "default" : isDragging ? "grabbing" : "grab" },
    },
  };
}
