import { useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";

function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (target.contentEditable === "true") return true;
  if (target.closest("[role='textbox']")) return true;
  return false;
}

export function useGoToSequence(basePath: string) {
  const navigate = useNavigate();
  const pendingG = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isInputElement(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "g" && !pendingG.current) {
        pendingG.current = true;
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => {
          pendingG.current = false;
        }, 1000);
        return;
      }

      if (pendingG.current) {
        pendingG.current = false;
        clearTimeout(timeout.current);

        switch (e.key) {
          case "p":
            e.preventDefault();
            navigate(basePath);
            break;
          case "r":
            e.preventDefault();
            navigate(`${basePath}/runs`);
            break;
          case "t":
            e.preventDefault();
            navigate(`${basePath}/test-cases`);
            break;
          case "v":
            e.preventDefault();
            navigate(`${basePath}/versions`);
            break;
        }
      }
    },
    [navigate, basePath],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      clearTimeout(timeout.current);
    };
  }, [handleKeyDown]);
}
