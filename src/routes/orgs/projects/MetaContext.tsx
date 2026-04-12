import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, MessageSquare, Plus, Trash2 } from "lucide-react";

interface QAPair {
  id: string;
  question: string;
  answer: string;
}

const SUGGESTED_QUESTIONS = [
  "What domain does this project operate in?",
  "What tone should the model use?",
  "Who is the end user?",
  "What should the model never do?",
];

export function MetaContext() {
  const { projectId, role } = useProject();
  const metaContext = useQuery(api.projects.getMetaContext, { projectId });
  const setMetaContext = useMutation(api.projects.setMetaContext);

  const [pairs, setPairs] = useState<QAPair[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Redirect non-owners
  if (role !== "owner") {
    return <Navigate to="/denied" replace />;
  }

  // Initialize from query data
  useEffect(() => {
    if (metaContext !== undefined && !initialized) {
      setPairs(
        metaContext.map((mc) => ({
          id: mc.id,
          question: mc.question,
          answer: mc.answer,
        })),
      );
      setInitialized(true);
    }
  }, [metaContext, initialized]);

  function addQuestion(question = "") {
    setPairs((prev) => [
      ...prev,
      { id: crypto.randomUUID(), question, answer: "" },
    ]);
  }

  function updatePair(id: string, field: "question" | "answer", value: string) {
    setPairs((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)),
    );
  }

  function removePair(id: string) {
    setPairs((prev) => prev.filter((p) => p.id !== id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = pairs.findIndex((p) => p.id === active.id);
    const newIndex = pairs.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...pairs];
    const [moved] = reordered.splice(oldIndex, 1);
    if (moved) reordered.splice(newIndex, 0, moved);
    setPairs(reordered);
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      await setMetaContext({ projectId, metaContext: pairs });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(friendlyError(err, "Failed to save meta context."));
    } finally {
      setSaving(false);
    }
  }

  if (metaContext === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Meta Context</h1>
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && (
        <p className="text-sm text-green-600">Saved successfully.</p>
      )}

      {pairs.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          heading="No meta context yet"
          description="Meta context feeds the optimizer. Add a question before your first optimization to ground the rewrite in your project's intent."
          action={{ label: "Add question", onClick: () => addQuestion() }}
        />
      ) : (
        <div className="flex gap-6">
          {/* Left — Q&A pairs */}
          <div className="flex-1 space-y-3">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={pairs.map((p) => p.id)}
                strategy={verticalListSortingStrategy}
              >
                {pairs.map((pair) => (
                  <SortableQAPair
                    key={pair.id}
                    pair={pair}
                    onUpdate={updatePair}
                    onRemove={removePair}
                  />
                ))}
              </SortableContext>
            </DndContext>

            <Button
              variant="outline"
              size="sm"
              onClick={() => addQuestion()}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add question
            </Button>
          </div>

          {/* Right — Suggested questions */}
          <div className="w-64 shrink-0">
            <h3 className="text-sm font-medium mb-2">Suggested questions</h3>
            <div className="space-y-1.5">
              {SUGGESTED_QUESTIONS.filter(
                (q) => !pairs.some((p) => p.question === q),
              ).map((question) => (
                <button
                  key={question}
                  className="w-full text-left text-sm text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors"
                  onClick={() => addQuestion(question)}
                >
                  {question}
                </button>
              ))}
              {SUGGESTED_QUESTIONS.every((q) =>
                pairs.some((p) => p.question === q),
              ) && (
                <p className="text-xs text-muted-foreground italic px-2">
                  All suggested questions added.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SortableQAPair({
  pair,
  onUpdate,
  onRemove,
}: {
  pair: QAPair;
  onUpdate: (id: string, field: "question" | "answer", value: string) => void;
  onRemove: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pair.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex gap-2 rounded-md border p-3"
    >
      <button
        className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing mt-1 shrink-0"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex-1 space-y-2">
        <Input
          value={pair.question}
          onChange={(e) => onUpdate(pair.id, "question", e.target.value)}
          placeholder="What domain does this project operate in?"
          className="font-medium"
        />
        <Textarea
          value={pair.answer}
          onChange={(e) => onUpdate(pair.id, "answer", e.target.value)}
          placeholder="Type your answer..."
          className="min-h-[60px]"
        />
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onRemove(pair.id)}
        className="mt-1 shrink-0"
      >
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>
    </div>
  );
}
