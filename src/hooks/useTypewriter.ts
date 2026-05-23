import { useEffect, useRef, useState } from "react";

interface UseTypewriterOptions {
  /** Reveal rate in chars/sec. Default 120 ~= 7200 wpm visual, feels like fast continuous typing. */
  charsPerSec?: number;
  /**
   * When false, displayed snaps to target immediately. Use this to skip animation
   * once a run completes so the final byte is on-screen without delay.
   */
  active?: boolean;
  /**
   * If displayed falls more than this many chars behind target, jump forward
   * to keep the animation from accumulating multi-second lag (e.g. after a tab
   * switch or a large single chunk).
   */
  maxLagChars?: number;
}

/**
 * Smooths visually-jumpy text updates by revealing characters at a fixed rate
 * via requestAnimationFrame. Designed for LLM streaming where the backend
 * batches chunks every ~80ms — without smoothing, text appears in visible
 * bursts; with it, every batch flows in as continuous typing.
 */
export function useTypewriter(
  target: string,
  { charsPerSec = 120, active = true, maxLagChars = 400 }: UseTypewriterOptions = {},
): string {
  const [displayed, setDisplayed] = useState(active ? "" : target);
  const displayedLenRef = useRef(active ? 0 : target.length);
  const targetRef = useRef(target);
  const lastTickRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  targetRef.current = target;

  // If target shrinks below current displayed length (e.g. a new run reset
  // the output to ""), resync immediately so we don't render stale text.
  if (target.length < displayedLenRef.current) {
    displayedLenRef.current = target.length;
    // Defer setState — we may be in render path. useEffect below will catch up.
  }

  useEffect(() => {
    if (!active) {
      // Snap to full when inactive (e.g., run completed).
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      displayedLenRef.current = targetRef.current.length;
      setDisplayed(targetRef.current);
      lastTickRef.current = null;
      return;
    }

    const tick = (now: number) => {
      const last = lastTickRef.current ?? now;
      const dt = now - last;
      lastTickRef.current = now;

      const t = targetRef.current;
      let len = displayedLenRef.current;

      if (len < t.length) {
        const advance = Math.max(1, Math.round((dt / 1000) * charsPerSec));
        len = Math.min(t.length, len + advance);

        // Jump-forward guard: if we're way behind, keep within maxLagChars of
        // the target so we don't accumulate seconds of visual lag.
        if (t.length - len > maxLagChars) {
          len = t.length - Math.floor(maxLagChars / 2);
        }

        displayedLenRef.current = len;
        setDisplayed(t.slice(0, len));
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTickRef.current = null;
    };
  }, [active, charsPerSec, maxLagChars]);

  return displayed;
}
