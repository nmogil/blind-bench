import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { VariableChipDecoration } from "./VariableChipExtension";
import { cn } from "@/lib/utils";
import { useEffect } from "react";

interface PromptEditorProps {
  content: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  validationError?: string;
  className?: string;
  /** Accessible name for screen readers. Falls back to placeholder, then a generic label. */
  ariaLabel?: string;
}

export function PromptEditor({
  content,
  onChange,
  readOnly = false,
  placeholder,
  validationError,
  className,
  ariaLabel,
}: PromptEditorProps) {
  const resolvedAriaLabel =
    ariaLabel ?? placeholder ?? "Prompt text editor";
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Plain text mode — disable all rich text features
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
      }),
      VariableChipDecoration,
    ],
    content: content || "",
    editable: !readOnly,
    onUpdate: ({ editor: e }) => {
      onChange(e.getText());
    },
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm max-w-none focus:outline-none min-h-[100px] px-3 py-2",
          readOnly && "opacity-60",
        ),
        "data-placeholder": placeholder ?? "",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": resolvedAriaLabel,
        "aria-readonly": readOnly ? "true" : "false",
        "aria-invalid": validationError ? "true" : "false",
      },
    },
  });

  // Sync readOnly prop changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!readOnly);
    }
  }, [readOnly, editor]);

  // Sync external content changes (e.g., when switching versions)
  useEffect(() => {
    if (editor && content !== editor.getText()) {
      editor.commands.setContent(content || "");
    }
  }, [content]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn("space-y-1", className)}>
      <div
        className={cn(
          "rounded-md border bg-transparent text-sm transition-colors",
          readOnly
            ? "border-muted bg-muted/30"
            : "border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          validationError && "border-destructive ring-3 ring-destructive/20",
        )}
      >
        <EditorContent editor={editor} />
      </div>
      {validationError && (
        <p className="text-xs text-destructive">{validationError}</p>
      )}
      <style>{`
        .variable-chip {
          background-color: hsl(var(--primary) / 0.1);
          color: hsl(var(--primary));
          border: 1px solid hsl(var(--primary) / 0.3);
          border-radius: 4px;
          padding: 1px 4px;
          font-family: var(--font-mono, ui-monospace, monospace);
          font-size: 0.85em;
        }
        .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: hsl(var(--muted-foreground));
          pointer-events: none;
          height: 0;
        }
        [data-placeholder]  .ProseMirror > p:first-child:empty::before {
          content: attr(data-placeholder);
          float: left;
          color: hsl(var(--muted-foreground));
          pointer-events: none;
          height: 0;
        }
      `}</style>
    </div>
  );
}
