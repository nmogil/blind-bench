import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id, Doc } from "../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Image as ImageIcon, Type } from "lucide-react";

type VariableType = "text" | "image";

function TypeOption({
  selected,
  disabled,
  onSelect,
  icon,
  label,
}: {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

interface AddVariableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: Id<"projects">;
  editingVariable?: Doc<"projectVariables"> | null;
}

export function AddVariableDialog({
  open,
  onOpenChange,
  projectId,
  editingVariable,
}: AddVariableDialogProps) {
  const addVariable = useMutation(api.variables.add);
  const updateVariable = useMutation(api.variables.update);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultValue, setDefaultValue] = useState("");
  const [required, setRequired] = useState(false);
  const [type, setType] = useState<VariableType>("text");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isEditing = !!editingVariable;

  useEffect(() => {
    if (editingVariable) {
      setName(editingVariable.name);
      setDescription(editingVariable.description ?? "");
      setDefaultValue(editingVariable.defaultValue ?? "");
      setRequired(editingVariable.required);
      setType(editingVariable.type ?? "text");
    } else {
      setName("");
      setDescription("");
      setDefaultValue("");
      setRequired(false);
      setType("text");
    }
    setError("");
  }, [editingVariable, open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setSaving(true);
    setError("");
    try {
      if (isEditing) {
        await updateVariable({
          variableId: editingVariable._id,
          name: name.trim(),
          description: description.trim() || undefined,
          defaultValue:
            type === "image" ? undefined : defaultValue.trim() || undefined,
          required,
        });
      } else {
        await addVariable({
          projectId,
          name: name.trim(),
          description: description.trim() || undefined,
          defaultValue:
            type === "image" ? undefined : defaultValue.trim() || undefined,
          required,
          type,
        });
      }
      onOpenChange(false);
    } catch (err) {
      setError(
        friendlyError(err, `Failed to ${isEditing ? "update" : "add"} variable.`),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit variable" : "Add variable"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Type</Label>
            <div
              role="radiogroup"
              aria-label="Variable type"
              className="inline-flex w-full rounded-md border bg-muted p-1"
            >
              <TypeOption
                selected={type === "text"}
                disabled={isEditing}
                onSelect={() => setType("text")}
                icon={<Type className="h-3.5 w-3.5" />}
                label="Text"
              />
              <TypeOption
                selected={type === "image"}
                disabled={isEditing}
                onSelect={() => setType("image")}
                icon={<ImageIcon className="h-3.5 w-3.5" />}
                label="Image"
              />
            </div>
            {isEditing && (
              <p className="text-xs text-muted-foreground">
                Variable type is locked after creation.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="var-name">Name</Label>
            <Input
              id="var-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="customer_name"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Reference in templates as {"{{"}
              {name || "name"}
              {"}}"}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="var-desc">Description (optional)</Label>
            <Input
              id="var-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="The customer's full name"
            />
          </div>
          {type === "text" && (
            <div className="space-y-2">
              <Label htmlFor="var-default">Default value (optional)</Label>
              <Input
                id="var-default"
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                placeholder="World"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id="var-required"
              checked={required}
              onCheckedChange={(checked) => setRequired(checked as boolean)}
            />
            <Label htmlFor="var-required" className="cursor-pointer">
              Required
            </Label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving
                ? isEditing
                  ? "Saving..."
                  : "Adding..."
                : isEditing
                  ? "Save"
                  : "Add variable"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
