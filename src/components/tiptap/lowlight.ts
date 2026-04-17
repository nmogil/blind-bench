import { common, createLowlight } from "lowlight";
import hljs from "highlight.js/lib/common";

// Shared lowlight instance — registered with highlight.js common languages.
// Exported for both Tiptap CodeBlockLowlight and paste-time auto-detection.
export const lowlight = createLowlight(common);

/**
 * Best-effort code detection for paste events. Returns a language id if the
 * clipboard text looks like code worth wrapping in a fenced block, else null.
 *
 * Intentionally conservative: prefers false negatives (paste as prose) over
 * false positives (wrap prose as code).
 */
export function detectCodeLanguage(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 20) return null;

  // JSON shape — both brackets + something in between
  if (/^[[{]/.test(trimmed) && /[}\]]\s*$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // shape looks right but invalid; fall through to auto-detect
    }
  }

  // XML/HTML shape — opening tag + a closing/self-closing tag somewhere
  if (/^<[A-Za-z?!][^>]*>/.test(trimmed) && /<\/[A-Za-z][^>]*>|\/>/.test(trimmed)) {
    return "xml";
  }

  // Only auto-detect for multi-line content — single-line pastes of prose
  // are too easy to misclassify.
  if (!trimmed.includes("\n")) return null;

  const subset = [
    "javascript",
    "typescript",
    "python",
    "bash",
    "sql",
    "json",
    "xml",
    "yaml",
    "rust",
    "go",
    "java",
    "cpp",
    "csharp",
    "ruby",
    "php",
  ];
  const result = hljs.highlightAuto(trimmed, subset);
  // highlight.js relevance score: ~10 = confident match. Keep the bar high.
  if (result.relevance >= 10 && result.language) {
    return result.language;
  }
  return null;
}
