import { useMemo } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import {
  Decoration,
  DecorationSet,
  MatchDecorator,
  ViewPlugin,
  ViewUpdate,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { cn } from "@/lib/utils";

export type EditorFormat = "plain" | "markdown";

interface PromptEditorProps {
  content: string;
  onChange: (content: string) => void;
  /** @deprecated Retained for API compatibility. Markdown syntax highlighting is always on. */
  format?: EditorFormat;
  readOnly?: boolean;
  placeholder?: string;
  validationError?: string;
  className?: string;
  ariaLabel?: string;
}

// Variable chip decoration: matches {{identifier}} and renders it as a styled span.
const variableMatcher = new MatchDecorator({
  regexp: /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
  decoration: () =>
    Decoration.mark({
      class: "cm-variable-chip",
      attributes: { "data-variable-chip": "true" },
    }),
});

const variableChipPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = variableMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = variableMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

// Theme derives all shades from `currentColor` and the app's CSS variables so
// it respects light/dark themes automatically.
const promptEditorTheme = EditorView.theme({
  "&": {
    fontSize: "13px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.6",
  },
  ".cm-content": {
    padding: "10px 0",
    caretColor: "var(--foreground)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "color-mix(in oklab, currentColor 40%, transparent)",
    border: "none",
    borderRight: "1px solid color-mix(in oklab, currentColor 10%, transparent)",
    paddingRight: "8px",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, currentColor 4%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "color-mix(in oklab, currentColor 70%, transparent)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 6px",
    minWidth: "24px",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--foreground)",
    borderLeftWidth: "2px",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, currentColor 18%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, currentColor 22%, transparent)",
  },
  ".cm-placeholder": {
    color: "color-mix(in oklab, currentColor 40%, transparent)",
    fontStyle: "normal",
  },
  ".cm-variable-chip": {
    backgroundColor: "color-mix(in oklab, var(--primary) 14%, transparent)",
    color: "var(--primary)",
    border: "1px solid color-mix(in oklab, var(--primary) 30%, transparent)",
    borderRadius: "4px",
    padding: "1px 4px",
    fontSize: "0.92em",
  },
  ".cm-variable-chip + .cm-variable-chip": { marginLeft: "1px" },
});

export function PromptEditor({
  content,
  onChange,
  readOnly = false,
  placeholder,
  validationError,
  className,
  ariaLabel,
}: PromptEditorProps) {
  const resolvedAriaLabel = ariaLabel ?? placeholder ?? "Prompt editor";

  const extensions = useMemo(
    () => [
      markdown(),
      variableChipPlugin,
      EditorView.lineWrapping,
      ...(placeholder ? [placeholderExt(placeholder)] : []),
      EditorView.contentAttributes.of({
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": resolvedAriaLabel,
        "aria-readonly": readOnly ? "true" : "false",
        "aria-invalid": validationError ? "true" : "false",
      }),
    ],
    [placeholder, readOnly, resolvedAriaLabel, validationError],
  );

  return (
    <div className={cn("space-y-1", className)} data-ph-mask>
      <div
        className={cn(
          "rounded-md border bg-transparent text-sm transition-colors overflow-hidden",
          readOnly
            ? "border-muted bg-muted/30"
            : "border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          validationError && "border-destructive ring-3 ring-destructive/20",
        )}
      >
        <CodeMirror
          value={content}
          onChange={onChange}
          extensions={extensions}
          editable={!readOnly}
          readOnly={readOnly}
          theme={promptEditorTheme}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: !readOnly,
            highlightActiveLineGutter: !readOnly,
            highlightSelectionMatches: false,
            bracketMatching: false,
            closeBrackets: false,
            autocompletion: false,
            indentOnInput: false,
            searchKeymap: false,
          }}
        />
      </div>
      {validationError && (
        <p className="text-xs text-destructive">{validationError}</p>
      )}
    </div>
  );
}
