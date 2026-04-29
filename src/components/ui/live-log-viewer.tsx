import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowDown } from "lucide-react";

import { cn } from "@/lib/utils";

interface LiveLogViewerProps {
  /** The full streamed content. Grows incrementally. */
  content: string;
  /** True while the source is actively streaming. Shows the cursor + sticky-bottom behavior. */
  isLive: boolean;
  /** Maximum bytes to render. Older content is replaced with a truncation marker. Default 50KB. */
  maxBytes?: number;
  /** Empty-state message. Default "Waiting for output…". */
  emptyMessage?: string;
  className?: string;
}

const TRUNCATION_PREFIX = "[earlier output truncated]\n";
const STICK_THRESHOLD_PX = 40;

/**
 * Streaming log viewer with smart auto-scroll. Sticks to the bottom while
 * isLive=true unless the user scrolls up — once they do, auto-scroll freezes
 * and a "Jump to bottom" pill appears.
 *
 * Truncates oversized logs by prepending a marker; keeps the tail end.
 */
export function LiveLogViewer({
  content,
  isLive,
  maxBytes = 50_000,
  emptyMessage = "Waiting for output…",
  className,
}: LiveLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  const { displayContent, truncated } = useMemo(() => {
    if (content.length <= maxBytes) {
      return { displayContent: content, truncated: false };
    }
    return {
      displayContent: content.slice(content.length - maxBytes),
      truncated: true,
    };
  }, [content, maxBytes]);

  // Detect user scrolling away from the bottom — freeze auto-scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      setStickToBottom(distanceFromBottom <= STICK_THRESHOLD_PX);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll to bottom on content updates when stuck.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !stickToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [displayContent, stickToBottom]);

  const jumpToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setStickToBottom(true);
  };

  const isEmpty = content.length === 0;

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg border bg-card overflow-hidden",
        className,
      )}
    >
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed text-foreground/90"
        role="log"
        aria-live={isLive ? "polite" : "off"}
        aria-busy={isLive}
        data-ph-mask
      >
        {isEmpty ? (
          <div
            className={cn(
              "text-muted-foreground italic",
              isLive && "motion-safe:animate-pulse",
            )}
          >
            {emptyMessage}
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words">
            {truncated && (
              <span className="block text-muted-foreground italic mb-1">
                {TRUNCATION_PREFIX}
              </span>
            )}
            {displayContent}
            {isLive && <span className="streaming-cursor" aria-hidden />}
          </pre>
        )}
      </div>
      {isLive && !stickToBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className={cn(
            "absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full",
            "bg-primary text-primary-foreground px-3 py-1 text-xs shadow-lg",
            "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          aria-label="Jump to bottom"
        >
          <ArrowDown className="h-3 w-3" />
          Jump to bottom
        </button>
      )}
    </div>
  );
}
