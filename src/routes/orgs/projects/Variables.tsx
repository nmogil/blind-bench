import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Doc } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { EmptyState } from "@/components/EmptyState";
import { AddVariableDialog } from "@/components/AddVariableDialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  Variable,
  Pencil,
  Trash2,
  Plus,
  Check,
} from "lucide-react";

export function Variables() {
  const { projectId } = useProject();
  const variables = useQuery(api.variables.list, { projectId });
  const deleteVariable = useMutation(api.variables.deleteVariable);
  const reorder = useMutation(api.variables.reorder);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingVariable, setEditingVariable] =
    useState<Doc<"projectVariables"> | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !variables) return;

    const oldIndex = variables.findIndex((v) => v._id === active.id);
    const newIndex = variables.findIndex((v) => v._id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...variables];
    const [moved] = reordered.splice(oldIndex, 1);
    if (moved) reordered.splice(newIndex, 0, moved);

    reorder({
      projectId,
      orderedIds: reordered.map((v) => v._id),
    });
  }

  async function handleDelete(variable: Doc<"projectVariables">) {
    setDeleteError("");
    try {
      await deleteVariable({ variableId: variable._id });
    } catch (err) {
      setDeleteError(friendlyError(err, "Failed to delete variable."));
    }
  }

  function handleEdit(variable: Doc<"projectVariables">) {
    setEditingVariable(variable);
    setDialogOpen(true);
  }

  function handleAddNew() {
    setEditingVariable(null);
    setDialogOpen(true);
  }

  if (variables === undefined) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Variables</h1>
        <Button onClick={handleAddNew} size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Add variable
        </Button>
      </div>

      {deleteError && (
        <p className="text-sm text-destructive">{deleteError}</p>
      )}

      {variables.length === 0 ? (
        <EmptyState
          icon={Variable}
          heading="No variables yet"
          description="Variables are project-scoped placeholders you can reference in any version. Create your first."
          action={{ label: "Add variable", onClick: handleAddNew }}
        />
      ) : (
        <div className="rounded-md border">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={variables.map((v) => v._id)}
              strategy={verticalListSortingStrategy}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Name</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Default value</TableHead>
                    <TableHead className="w-20">Required</TableHead>
                    <TableHead className="w-20">Used in</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variables.map((variable) => (
                    <SortableVariableRow
                      key={variable._id}
                      variable={variable}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </TableBody>
              </Table>
            </SortableContext>
          </DndContext>
        </div>
      )}

      <AddVariableDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
        editingVariable={editingVariable}
      />
    </div>
  );
}

function SortableVariableRow({
  variable,
  onEdit,
  onDelete,
}: {
  variable: Doc<"projectVariables">;
  onEdit: (v: Doc<"projectVariables">) => void;
  onDelete: (v: Doc<"projectVariables">) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: variable._id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <TableRow ref={setNodeRef} style={style}>
      <TableCell>
        <button
          className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      </TableCell>
      <TableCell className="font-mono text-sm">{variable.name}</TableCell>
      <TableCell className="text-muted-foreground">
        {variable.description || "—"}
      </TableCell>
      <TableCell className="font-mono text-sm text-muted-foreground">
        {variable.defaultValue || "—"}
      </TableCell>
      <TableCell>
        {variable.required && (
          <Check className="h-4 w-4 text-primary" />
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">—</TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onEdit(variable)}
                />
              }
            >
              <Pencil className="h-3.5 w-3.5" />
            </TooltipTrigger>
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onDelete(variable)}
                />
              }
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  );
}
