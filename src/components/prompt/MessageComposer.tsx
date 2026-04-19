import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PromptEditor } from "@/components/tiptap/PromptEditor";
import {
  AnnotatedEditor,
  type Annotation,
} from "@/components/tiptap/AnnotatedEditor";
import {
  genMessageId,
  getMessageText,
  rolePlaceholder,
  roleLabel,
  type PromptMessage,
  type PromptMessageRole,
} from "@/lib/promptMessages";
import { cn } from "@/lib/utils";

interface MessageComposerProps {
  messages: PromptMessage[];
  onChange: (messages: PromptMessage[]) => void;
  readOnly?: boolean;
  feedbackMode?: boolean;
  annotationsByMessageId?: Record<string, Annotation[]>;
  onCreateAnnotation?: (
    messageId: string,
    from: number,
    to: number,
    highlightedText: string,
    comment: string,
  ) => void;
  onUpdateAnnotation?: (id: string, comment: string) => void;
  onDeleteAnnotation?: (id: string) => void;
}

const ADDABLE_ROLES: PromptMessageRole[] = [
  "system",
  "developer",
  "user",
  "assistant",
];

export function MessageComposer({
  messages,
  onChange,
  readOnly = false,
  feedbackMode = false,
  annotationsByMessageId,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
}: MessageComposerProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Track which message each editor belongs to so the ⌘⌫ shortcut knows what
  // to delete even when focus is inside CodeMirror.
  const activeRef = useRef<string | null>(null);
  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = messages.findIndex((m) => m.id === active.id);
      const newIndex = messages.findIndex((m) => m.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      onChange(arrayMove(messages, oldIndex, newIndex));
    },
    [messages, onChange],
  );

  const updateContent = useCallback(
    (id: string, content: string) => {
      onChange(
        messages.map((m) => (m.id === id ? ({ ...m, content } as PromptMessage) : m)),
      );
    },
    [messages, onChange],
  );

  const updateRole = useCallback(
    (id: string, role: PromptMessageRole) => {
      onChange(
        messages.map((m) => {
          if (m.id !== id) return m;
          const text = getMessageText(m);
          if (role === "assistant") {
            return { id: m.id, role, content: text } as PromptMessage;
          }
          return {
            id: m.id,
            role,
            content: text,
            format: "format" in m ? m.format : undefined,
          } as PromptMessage;
        }),
      );
    },
    [messages, onChange],
  );

  const deleteMessage = useCallback(
    (id: string) => {
      // Preserve the invariant: at least one user message must remain.
      const target = messages.find((m) => m.id === id);
      if (!target) return;
      const remaining = messages.filter((m) => m.id !== id);
      const stillHasUser = remaining.some((m) => m.role === "user");
      if (!stillHasUser) return;
      onChange(remaining);
    },
    [messages, onChange],
  );

  const addMessage = useCallback(
    (role: PromptMessageRole) => {
      const next: PromptMessage =
        role === "assistant"
          ? { id: genMessageId(), role, content: "" }
          : { id: genMessageId(), role, content: "", format: "plain" };
      onChange([...messages, next]);
    },
    [messages, onChange],
  );

  // Keyboard shortcuts within the composer — ⌘↵ adds a user turn; ⌘⌫ deletes
  // the focused one. Editor-local keybindings (save, etc.) still run first.
  useEffect(() => {
    if (readOnly || feedbackMode) return;
    function onKey(e: KeyboardEvent) {
      if (!containerRef.current?.contains(e.target as Node)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "Enter" && !e.shiftKey) {
        // Composer's ⌘↵ is reserved for Save at the page level; don't steal.
        return;
      }
      if (e.key === "Backspace" && e.shiftKey) {
        e.preventDefault();
        const id = activeRef.current;
        if (id) deleteMessage(id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, feedbackMode, deleteMessage]);

  const canDelete = (id: string) => {
    const remaining = messages.filter((m) => m.id !== id);
    return remaining.some((m) => m.role === "user");
  };

  return (
    <div ref={containerRef} className="space-y-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={messages.map((m) => m.id)}
          strategy={verticalListSortingStrategy}
        >
          {messages.map((message) => (
            <MessageBlock
              key={message.id}
              message={message}
              readOnly={readOnly}
              feedbackMode={feedbackMode}
              canDelete={canDelete(message.id)}
              isActive={activeId === message.id}
              onFocus={() => setActiveId(message.id)}
              onBlur={() => {
                setActiveId((prev) => (prev === message.id ? null : prev));
              }}
              onContentChange={(content) => updateContent(message.id, content)}
              onRoleChange={(role) => updateRole(message.id, role)}
              onDelete={() => deleteMessage(message.id)}
              annotations={annotationsByMessageId?.[message.id] ?? []}
              onCreateAnnotation={
                onCreateAnnotation
                  ? (from, to, text, comment) =>
                      onCreateAnnotation(
                        message.id,
                        from,
                        to,
                        text,
                        comment,
                      )
                  : undefined
              }
              onUpdateAnnotation={onUpdateAnnotation}
              onDeleteAnnotation={onDeleteAnnotation}
            />
          ))}
        </SortableContext>
      </DndContext>

      {!readOnly && !feedbackMode && (
        <AddMessageMenu onAdd={addMessage} />
      )}
    </div>
  );
}

interface MessageBlockProps {
  message: PromptMessage;
  readOnly: boolean;
  feedbackMode: boolean;
  canDelete: boolean;
  isActive: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onContentChange: (content: string) => void;
  onRoleChange: (role: PromptMessageRole) => void;
  onDelete: () => void;
  annotations: Annotation[];
  onCreateAnnotation?: (
    from: number,
    to: number,
    highlightedText: string,
    comment: string,
  ) => void;
  onUpdateAnnotation?: (id: string, comment: string) => void;
  onDeleteAnnotation?: (id: string) => void;
}

function MessageBlock({
  message,
  readOnly,
  feedbackMode,
  canDelete,
  isActive,
  onFocus,
  onBlur,
  onContentChange,
  onRoleChange,
  onDelete,
  annotations,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
}: MessageBlockProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: message.id,
    disabled: readOnly || feedbackMode,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const content = getMessageText(message);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-lg border bg-background",
        isDragging && "opacity-60 ring-1 ring-primary/40",
        isActive && !feedbackMode && "border-ring",
      )}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        {!readOnly && !feedbackMode && (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder"
            className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}

        <RolePill
          role={message.role}
          readOnly={readOnly || feedbackMode}
          onChange={onRoleChange}
        />

        <div className="flex-1" />

        {!readOnly && !feedbackMode && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDelete}
            disabled={!canDelete}
            aria-label={`Delete ${roleLabel(message.role)} message`}
            title={
              canDelete
                ? "Delete message"
                : "A prompt needs at least one user message"
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="p-2">
        {feedbackMode ? (
          <AnnotatedEditor
            content={content}
            format="markdown"
            annotations={annotations}
            canAnnotate={!!onCreateAnnotation}
            onCreateAnnotation={onCreateAnnotation}
            onUpdateAnnotation={onUpdateAnnotation}
            onDeleteAnnotation={onDeleteAnnotation}
            ariaLabel={`${roleLabel(message.role)} message — select text to leave a comment`}
          />
        ) : (
          <PromptEditor
            content={content}
            onChange={onContentChange}
            readOnly={readOnly}
            placeholder={rolePlaceholder(message.role)}
            ariaLabel={`${roleLabel(message.role)} message`}
          />
        )}
      </div>
    </div>
  );
}

function RolePill({
  role,
  readOnly,
  onChange,
}: {
  role: PromptMessageRole;
  readOnly: boolean;
  onChange: (role: PromptMessageRole) => void;
}) {
  const label = roleLabel(role);
  const classes = cn(
    "inline-flex h-6 items-center rounded-full px-2 text-[11px] font-medium uppercase tracking-wide",
    roleClassName(role),
  );

  if (readOnly) {
    return <span className={classes}>{label}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(classes, "hover:brightness-110")}
        aria-label={`Change role from ${label}`}
      >
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {ADDABLE_ROLES.map((r) => (
          <DropdownMenuItem
            key={r}
            onClick={() => onChange(r)}
            disabled={r === role}
          >
            {roleLabel(r)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function roleClassName(role: PromptMessageRole): string {
  switch (role) {
    case "system":
      return "bg-primary/12 text-primary border border-primary/25";
    case "developer":
      return "bg-primary/8 text-primary/90 border border-primary/20";
    case "user":
      return "bg-muted text-foreground border border-border";
    case "assistant":
      return "bg-muted/60 text-muted-foreground border border-border";
  }
}

function AddMessageMenu({
  onAdd,
}: {
  onAdd: (role: PromptMessageRole) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-xs hover:bg-accent">
        <Plus className="h-3.5 w-3.5" />
        Add message
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {ADDABLE_ROLES.map((r) => (
          <DropdownMenuItem key={r} onClick={() => onAdd(r)}>
            {roleLabel(r)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
