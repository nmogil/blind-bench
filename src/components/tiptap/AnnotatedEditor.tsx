import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Markdown } from "tiptap-markdown";
import {
  AnnotationHighlightExtension,
  annotationPluginKey,
  type AnnotationRange,
} from "./AnnotationHighlightExtension";
import { lowlight } from "./lowlight";
import type { EditorFormat } from "./PromptEditor";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MessageSquarePlus, Pencil, Trash2, X } from "lucide-react";

export interface Annotation {
  _id?: string;
  from: number;
  to: number;
  highlightedText: string;
  comment: string;
  authorName?: string;
  isOwn?: boolean;
}

interface AnnotatedEditorProps {
  content: string;
  annotations: Annotation[];
  format?: EditorFormat;
  onCreateAnnotation?: (
    from: number,
    to: number,
    highlightedText: string,
    comment: string,
  ) => void;
  onUpdateAnnotation?: (id: string, comment: string) => void;
  onDeleteAnnotation?: (id: string) => void;
  showAuthor?: boolean;
  canAnnotate?: boolean;
  className?: string;
  /** Accessible name for the annotatable text. Falls back to a generic label. */
  ariaLabel?: string;
}

interface PendingComment {
  from: number;
  to: number;
  highlightedText: string;
}

export function AnnotatedEditor({
  content,
  annotations,
  format = "plain",
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  showAuthor = true,
  canAnnotate = true,
  className,
  ariaLabel,
}: AnnotatedEditorProps) {
  const resolvedAriaLabel =
    ariaLabel ??
    (canAnnotate
      ? "Model output — select text to leave feedback"
      : "Model output");
  const [commentText, setCommentText] = useState("");
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(
    null,
  );
  const [activeAnnotation, setActiveAnnotation] = useState<Annotation | null>(
    null,
  );
  const [editingComment, setEditingComment] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const extensions = useMemo(() => {
    if (format === "markdown") {
      return [
        StarterKit.configure({ codeBlock: false }),
        CodeBlockLowlight.configure({ lowlight }),
        Markdown.configure({
          html: false,
          tightLists: true,
          linkify: true,
          breaks: false,
        }),
        AnnotationHighlightExtension,
      ];
    }
    return [
      StarterKit.configure({
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
      AnnotationHighlightExtension,
    ];
  }, [format]);

  const editor = useEditor(
    {
      extensions,
      content: content || "",
      editable: true, // Needed for selections + BubbleMenu
      editorProps: {
        attributes: {
          class: cn(
            "prose prose-sm max-w-none focus:outline-none min-h-[200px] px-3 py-2",
            format === "plain" &&
              "whitespace-pre-wrap font-mono leading-relaxed text-sm",
            format === "markdown" && "leading-relaxed text-sm",
          ),
          role: "textbox",
          "aria-multiline": "true",
          "aria-readonly": "true",
          "aria-label": resolvedAriaLabel,
        },
        handlePaste: () => true,
        handleDrop: () => true,
      },
    },
    [format, extensions],
  );

  // Sync external content changes
  useEffect(() => {
    if (editor && content !== editor.getText()) {
      editor.commands.setContent(content || "");
    }
  }, [content]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push annotation ranges into the decoration plugin.
  // Ranges change less often than the annotations array reference, so we
  // dedup via a serialized key to avoid re-dispatching on every parent render.
  const lastRangesKeyRef = useRef<string>("");
  useEffect(() => {
    if (!editor) return;
    const ranges: AnnotationRange[] = annotations.map((a) => ({
      id: a._id,
      from: a.from,
      to: a.to,
    }));
    const key = ranges
      .map((r) => `${r.id ?? ""}:${r.from}-${r.to}`)
      .join("|");
    if (key === lastRangesKeyRef.current) return;
    lastRangesKeyRef.current = key;
    const tr = editor.state.tr.setMeta(annotationPluginKey, ranges);
    editor.view.dispatch(tr);
  }, [editor, annotations]);

  // Handle clicking on annotation highlights
  useEffect(() => {
    if (!editor) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const highlightEl = target.closest(".annotation-highlight");
      if (!highlightEl) {
        if (!pendingComment) setActiveAnnotation(null);
        return;
      }
      const annId = highlightEl.getAttribute("data-annotation-id");
      if (annId) {
        const ann = annotations.find((a) => a._id === annId);
        if (ann) {
          setActiveAnnotation(ann);
          setIsEditing(false);
          setPendingComment(null);
        }
      }
    };
    const editorDom = editor.view.dom;
    editorDom.addEventListener("click", handleClick);
    return () => editorDom.removeEventListener("click", handleClick);
  }, [editor, annotations, pendingComment]);

  // Capture selection and open comment form
  const handleStartComment = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const highlightedText = editor.state.doc.textBetween(from, to);
    setPendingComment({ from, to, highlightedText });
    setActiveAnnotation(null);
    setCommentText("");
  }, [editor]);

  const handleSubmitComment = useCallback(() => {
    if (!pendingComment || !commentText.trim() || !onCreateAnnotation) return;
    onCreateAnnotation(
      pendingComment.from,
      pendingComment.to,
      pendingComment.highlightedText,
      commentText.trim(),
    );
    setCommentText("");
    setPendingComment(null);
  }, [pendingComment, commentText, onCreateAnnotation]);

  const handleCancelComment = useCallback(() => {
    setPendingComment(null);
    setCommentText("");
  }, []);

  const handleUpdateComment = useCallback(() => {
    if (!activeAnnotation?._id || !editingComment.trim() || !onUpdateAnnotation)
      return;
    onUpdateAnnotation(activeAnnotation._id, editingComment.trim());
    setIsEditing(false);
    setActiveAnnotation(null);
  }, [activeAnnotation, editingComment, onUpdateAnnotation]);

  const handleDeleteAnnotation = useCallback(() => {
    if (!activeAnnotation?._id || !onDeleteAnnotation) return;
    onDeleteAnnotation(activeAnnotation._id);
    setActiveAnnotation(null);
  }, [activeAnnotation, onDeleteAnnotation]);

  // Focus textarea when comment form opens
  useEffect(() => {
    if (pendingComment && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [pendingComment]);

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "rounded-md border bg-transparent text-sm transition-colors",
          "border-muted bg-muted/30",
        )}
      >
        <EditorContent editor={editor} />

        {/* BubbleMenu: "Comment" button appears on text selection */}
        {editor && canAnnotate && !pendingComment && (
          <BubbleMenu
            editor={editor}
            shouldShow={({ editor: e }) => {
              const { from, to } = e.state.selection;
              return from !== to;
            }}
          >
            <Button
              size="sm"
              variant="secondary"
              className="shadow-md"
              onClick={handleStartComment}
            >
              <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
              Comment
            </Button>
          </BubbleMenu>
        )}
      </div>

      {/* Comment form — rendered outside BubbleMenu so it persists */}
      {pendingComment && (
        <div className="absolute left-0 right-0 top-full z-20 mt-2">
          <div className="rounded-lg border bg-popover p-3 shadow-lg mx-2">
            <div className="flex items-start justify-between mb-2">
              <blockquote className="border-l-2 border-blue-400 pl-2 text-xs text-muted-foreground italic flex-1 truncate">
                {pendingComment.highlightedText}
              </blockquote>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={handleCancelComment}
                className="shrink-0 ml-2"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
            <Textarea
              ref={textareaRef}
              value={commentText}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setCommentText(e.target.value)
              }
              placeholder="Leave feedback..."
              className="min-h-[80px] text-sm"
              onKeyDown={(e: React.KeyboardEvent) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleSubmitComment();
                }
                if (e.key === "Escape") {
                  handleCancelComment();
                }
              }}
            />
            <div className="flex items-center justify-between mt-2">
              <p className="text-xs text-muted-foreground">
                {"\u2318"}Enter to submit
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={handleCancelComment}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSubmitComment}
                  disabled={!commentText.trim()}
                >
                  Submit
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Active annotation detail panel */}
      {activeAnnotation && (
        <div className="absolute right-0 top-0 z-10 w-72 rounded-lg border bg-popover p-3 shadow-md">
          <div className="space-y-2">
            <div className="flex items-start justify-between">
              <blockquote className="border-l-2 border-blue-400 pl-2 text-xs text-muted-foreground italic flex-1">
                {activeAnnotation.highlightedText}
              </blockquote>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setActiveAnnotation(null)}
                className="shrink-0 ml-2"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
            {showAuthor && activeAnnotation.authorName && (
              <p className="text-xs font-medium">
                {activeAnnotation.authorName}
              </p>
            )}
            {isEditing ? (
              <>
                <Textarea
                  value={editingComment}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setEditingComment(e.target.value)
                  }
                  className="min-h-[60px] text-sm"
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      handleUpdateComment();
                    }
                  }}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setIsEditing(false)}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleUpdateComment}>
                    Save
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm">{activeAnnotation.comment}</p>
                {activeAnnotation.isOwn && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setIsEditing(true);
                        setEditingComment(activeAnnotation.comment);
                      }}
                    >
                      <Pencil className="mr-1 h-3 w-3" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={handleDeleteAnnotation}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      Delete
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <style>{`
        .annotation-highlight {
          background-color: hsl(217 91% 60% / 0.18);
          border-bottom: 2px solid hsl(217 91% 55% / 0.7);
          cursor: pointer;
          border-radius: 2px;
          transition: background-color 0.15s;
        }
        .annotation-highlight:hover {
          background-color: hsl(217 91% 60% / 0.28);
        }
        :is(.dark) .annotation-highlight {
          background-color: hsl(217 91% 70% / 0.22);
          border-bottom-color: hsl(217 91% 75% / 0.85);
        }
        :is(.dark) .annotation-highlight:hover {
          background-color: hsl(217 91% 70% / 0.32);
        }
      `}</style>
    </div>
  );
}
