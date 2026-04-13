import { useEffect, useState, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import {
  AnnotationHighlightExtension,
  annotationPluginKey,
  type AnnotationRange,
} from "./AnnotationHighlightExtension";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { MessageSquarePlus, Pencil, Trash2 } from "lucide-react";

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
}

export function AnnotatedEditor({
  content,
  annotations,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  showAuthor = true,
  canAnnotate = true,
  className,
}: AnnotatedEditorProps) {
  const [commentText, setCommentText] = useState("");
  const [isCommenting, setIsCommenting] = useState(false);
  const [activeAnnotation, setActiveAnnotation] = useState<Annotation | null>(
    null,
  );
  const [editingComment, setEditingComment] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const editor = useEditor({
    extensions: [
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
    ],
    content: content || "",
    editable: true, // Needed for selections + BubbleMenu
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm max-w-none focus:outline-none min-h-[200px] px-3 py-2",
          "whitespace-pre-wrap font-mono leading-relaxed text-sm",
        ),
      },
      // Prevent paste/drop from modifying content
      handlePaste: () => true,
      handleDrop: () => true,
    },
  });

  // Sync external content changes
  useEffect(() => {
    if (editor && content !== editor.getText()) {
      editor.commands.setContent(content || "");
    }
  }, [content]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push annotation ranges into the decoration plugin
  useEffect(() => {
    if (!editor) return;
    const ranges: AnnotationRange[] = annotations.map((a) => ({
      id: a._id,
      from: a.from,
      to: a.to,
    }));
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
        setActiveAnnotation(null);
        return;
      }
      const annId = highlightEl.getAttribute("data-annotation-id");
      if (annId) {
        const ann = annotations.find((a) => a._id === annId);
        if (ann) {
          setActiveAnnotation(ann);
          setIsEditing(false);
        }
      }
    };
    const editorDom = editor.view.dom;
    editorDom.addEventListener("click", handleClick);
    return () => editorDom.removeEventListener("click", handleClick);
  }, [editor, annotations]);

  const handleSubmitComment = useCallback(() => {
    if (!editor || !commentText.trim() || !onCreateAnnotation) return;

    const { from, to } = editor.state.selection;
    if (from === to) return;

    const highlightedText = editor.state.doc.textBetween(from, to);
    onCreateAnnotation(from, to, highlightedText, commentText.trim());

    setCommentText("");
    setIsCommenting(false);
  }, [editor, commentText, onCreateAnnotation]);

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

  // Focus textarea when comment popover opens
  useEffect(() => {
    if (isCommenting && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isCommenting]);

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "rounded-md border bg-transparent text-sm transition-colors",
          "border-muted bg-muted/30",
        )}
      >
        <EditorContent editor={editor} />

        {/* Floating "Add Comment" button on text selection */}
        {editor && canAnnotate && (
          <BubbleMenu
            editor={editor}
            shouldShow={({ editor: e }) => {
              const { from, to } = e.state.selection;
              return from !== to && !isCommenting;
            }}
          >
            <Popover
              open={isCommenting}
              onOpenChange={(open) => {
                setIsCommenting(open);
                if (!open) setCommentText("");
              }}
            >
              <PopoverTrigger
                render={
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shadow-md"
                    onClick={() => setIsCommenting(true)}
                  />
                }
              >
                <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
                Comment
              </PopoverTrigger>
              <PopoverContent side="bottom" className="w-72">
                <Textarea
                  ref={textareaRef}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Leave feedback..."
                  className="min-h-[80px] text-sm"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      handleSubmitComment();
                    }
                    if (e.key === "Escape") {
                      setIsCommenting(false);
                      setCommentText("");
                    }
                  }}
                />
                <div className="flex justify-end gap-2 mt-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setIsCommenting(false);
                      setCommentText("");
                    }}
                  >
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
                <p className="text-xs text-muted-foreground mt-1">
                  {"\u2318"}Enter to submit
                </p>
              </PopoverContent>
            </Popover>
          </BubbleMenu>
        )}
      </div>

      {/* Active annotation detail popover */}
      {activeAnnotation && (
        <div className="absolute right-0 top-0 z-10 w-72 rounded-lg border bg-popover p-3 shadow-md">
          <div className="space-y-2">
            <blockquote className="border-l-2 border-blue-400 pl-2 text-xs text-muted-foreground italic">
              {activeAnnotation.highlightedText}
            </blockquote>
            {showAuthor && activeAnnotation.authorName && (
              <p className="text-xs font-medium">
                {activeAnnotation.authorName}
              </p>
            )}
            {isEditing ? (
              <>
                <Textarea
                  value={editingComment}
                  onChange={(e) => setEditingComment(e.target.value)}
                  className="min-h-[60px] text-sm"
                  onKeyDown={(e) => {
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
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => setActiveAnnotation(null)}
            >
              Close
            </Button>
          </div>
        </div>
      )}

      <style>{`
        .annotation-highlight {
          background-color: hsl(217 91% 60% / 0.15);
          border-bottom: 2px solid hsl(217 91% 60% / 0.5);
          cursor: pointer;
          border-radius: 2px;
          transition: background-color 0.15s;
        }
        .annotation-highlight:hover {
          background-color: hsl(217 91% 60% / 0.25);
        }
      `}</style>
    </div>
  );
}

