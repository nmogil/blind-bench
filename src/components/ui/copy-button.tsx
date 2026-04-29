import { useState, useRef, useCallback } from "react";
import { Check, Copy } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const copyButtonVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-md text-xs transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  {
    variants: {
      variant: {
        overlay:
          "absolute top-1.5 right-1.5 h-7 w-7 bg-background/80 backdrop-blur border border-border hover:bg-accent hover:text-accent-foreground",
        inline:
          "h-7 px-2 text-muted-foreground hover:text-foreground hover:bg-muted",
      },
    },
    defaultVariants: {
      variant: "inline",
    },
  },
);

interface CopyButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">,
    VariantProps<typeof copyButtonVariants> {
  text: string;
  label?: string;
  /** Optional element to announce after copying for screen readers. */
  copiedLabel?: string;
}

/**
 * Falls back to a hidden textarea + execCommand when navigator.clipboard is
 * unavailable (non-HTTPS contexts, sandboxed iframes, very old browsers).
 */
function copyTextFallback(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  text,
  label,
  copiedLabel = "Copied",
  variant,
  className,
  onClick,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const handleClick = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (e.defaultPrevented) return;

      let ok = false;
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch {
          ok = copyTextFallback(text);
        }
      } else {
        ok = copyTextFallback(text);
      }

      if (!ok) return;
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1500);
    },
    [onClick, text],
  );

  return (
    <button
      type="button"
      aria-label={copied ? copiedLabel : (label ?? "Copy")}
      aria-live="polite"
      className={cn(copyButtonVariants({ variant }), className)}
      onClick={handleClick}
      {...props}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {variant === "inline" && label && (
        <span>{copied ? copiedLabel : label}</span>
      )}
    </button>
  );
}

export { copyButtonVariants };
