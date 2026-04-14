import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Doc } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  GripVertical,
  FlaskConical,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function TestCases() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const testCases = useQuery(api.testCases.list, { projectId });
  const variables = useQuery(api.variables.list, { projectId });
  const createTestCase = useMutation(api.testCases.create);
  const deleteTestCase = useMutation(api.testCases.deleteTestCase);
  const reorder = useMutation(api.testCases.reorder);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const selectedTestCase = testCases?.find((tc) => tc._id === selectedId);

  async function handleCreate() {
    setError("");
    try {
      // Build default variable values from project variables
      const defaults: Record<string, string> = {};
      if (variables) {
        for (const v of variables) {
          if (v.defaultValue) defaults[v.name] = v.defaultValue;
        }
      }
      const id = await createTestCase({
        projectId,
        name: "Untitled test case",
        variableValues: defaults,
      });
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/test-cases/${id}`,
      );
    } catch (err) {
      setError(friendlyError(err, "Failed to create test case."));
    }
  }

  async function handleDelete(tc: Doc<"testCases">) {
    setError("");
    try {
      if (selectedId === tc._id) setSelectedId(null);
      await deleteTestCase({ testCaseId: tc._id });
    } catch (err) {
      setError(friendlyError(err, "Failed to delete test case."));
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !testCases) return;

    const oldIndex = testCases.findIndex((tc) => tc._id === active.id);
    const newIndex = testCases.findIndex((tc) => tc._id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...testCases];
    const [moved] = reordered.splice(oldIndex, 1);
    if (moved) reordered.splice(newIndex, 0, moved);

    reorder({
      projectId,
      orderedIds: reordered.map((tc) => tc._id),
    });
  }

  if (testCases === undefined) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-36" />
        </div>
        <div className="flex gap-4">
          <div className="w-72 space-y-2">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
          <Skeleton className="flex-1 h-64" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Test Cases</h1>
        <Button onClick={handleCreate} size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          New test case
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {testCases.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          heading="No test cases"
          description="A test case is a set of variable values that gets plugged into your prompt. Create several to see how your prompt handles different scenarios."
          action={{ label: "New test case", onClick: handleCreate }}
        />
      ) : (
        <div className="flex gap-4 min-h-[400px]">
          {/* Left rail — test case list */}
          <div className="w-72 shrink-0 border rounded-md overflow-hidden">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={testCases.map((tc) => tc._id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="divide-y">
                  {testCases.map((tc) => (
                    <SortableTestCaseCard
                      key={tc._id}
                      testCase={tc}
                      isSelected={selectedId === tc._id}
                      onSelect={() => setSelectedId(tc._id)}
                      onDelete={() => handleDelete(tc)}
                      onOpen={() =>
                        navigate(
                          `/orgs/${orgSlug}/projects/${projectId}/test-cases/${tc._id}`,
                        )
                      }
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>

          {/* Right pane — preview */}
          <div className="flex-1 border rounded-md p-4">
            {selectedTestCase ? (
              <TestCasePreview
                testCase={selectedTestCase}
                variables={variables ?? []}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Select a test case to preview
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SortableTestCaseCard({
  testCase,
  isSelected,
  onSelect,
  onDelete,
  onOpen,
}: {
  testCase: Doc<"testCases">;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: testCase._id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const varCount = Object.keys(testCase.variableValues).length;
  const attachCount = testCase.attachmentIds.length;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-muted/50",
        isSelected && "bg-muted",
      )}
      onClick={onSelect}
    >
      <button
        className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing shrink-0"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{testCase.name}</p>
        <p className="text-xs text-muted-foreground">
          {varCount} variable{varCount !== 1 ? "s" : ""}
          {attachCount > 0 && ` · ${attachCount} attachment${attachCount !== 1 ? "s" : ""}`}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title="Open in editor"
        >
          <span className="text-xs">Edit</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>
    </div>
  );
}

function TestCasePreview({
  testCase,
  variables,
}: {
  testCase: Doc<"testCases">;
  variables: Doc<"projectVariables">[];
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{testCase.name}</h2>

      {variables.length === 0 &&
      Object.keys(testCase.variableValues).length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No variables defined for this prompt yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Variable</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {variables.map((v) => (
              <TableRow key={v._id}>
                <TableCell className="font-mono text-sm">{v.name}</TableCell>
                <TableCell className="text-sm">
                  {testCase.variableValues[v.name] || (
                    <span className="text-muted-foreground italic">empty</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {/* Show extra values not matching current variables */}
            {Object.entries(testCase.variableValues)
              .filter(([key]) => !variables.some((v) => v.name === key))
              .map(([key, value]) => (
                <TableRow key={key} className="opacity-50">
                  <TableCell className="font-mono text-sm">
                    {key}
                    <span className="ml-1 text-xs text-muted-foreground">
                      (removed)
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">{value}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}

      {testCase.attachmentIds.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">Attachments</h3>
          <p className="text-xs text-muted-foreground">
            {testCase.attachmentIds.length} attachment
            {testCase.attachmentIds.length !== 1 ? "s" : ""} (preview coming in
            M3)
          </p>
        </div>
      )}
    </div>
  );
}
