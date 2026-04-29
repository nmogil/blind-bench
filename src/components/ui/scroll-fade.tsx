import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

interface ScrollFadeProps {
  children: ReactNode;
  className?: string;
  /** Fade height in pixels. Defaults to 24. */
  fadeSize?: number;
  /** Override the fade color. Defaults to var(--background). */
  fadeColor?: string;
}

/**
 * Wrapper that renders top/bottom gradient masks when child content overflows.
 * Uses a ResizeObserver + scroll listener to detect overflow + scroll position.
 * Respects prefers-reduced-motion (instant show/hide instead of fade transition).
 */
export function ScrollFade({
  children,
  className,
  fadeSize = 24,
  fadeColor,
}: ScrollFadeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);
  const [showBottom, setShowBottom] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const overflows = scrollHeight > clientHeight + 1;
      setShowTop(overflows && scrollTop > 0);
      setShowBottom(overflows && scrollTop + clientHeight < scrollHeight - 1);
    };

    update();
    el.addEventListener("scroll", update, { passive: true });

    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Watch first child too — if its size changes, overflow may change.
    if (el.firstElementChild) ro.observe(el.firstElementChild);

    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  const color = fadeColor ?? "var(--color-background, white)";

  return (
    <div className={cn("relative", className)}>
      <div
        ref={containerRef}
        className="h-full w-full overflow-y-auto overflow-x-hidden"
      >
        {children}
      </div>
      {/* Top fade */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 transition-opacity duration-150",
          "motion-reduce:transition-none",
          showTop ? "opacity-100" : "opacity-0",
        )}
        style={{
          height: fadeSize,
          background: `linear-gradient(to bottom, ${color}, transparent)`,
        }}
      />
      {/* Bottom fade */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 transition-opacity duration-150",
          "motion-reduce:transition-none",
          showBottom ? "opacity-100" : "opacity-0",
        )}
        style={{
          height: fadeSize,
          background: `linear-gradient(to top, ${color}, transparent)`,
        }}
      />
    </div>
  );
}
