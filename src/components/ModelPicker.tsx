import { MODELS } from "@/lib/models";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye } from "lucide-react";

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  hasAttachments?: boolean;
}

export function ModelPicker({ value, onChange, hasAttachments }: ModelPickerProps) {
  const filtered = hasAttachments
    ? MODELS.filter((m) => m.supportsVision)
    : MODELS;

  return (
    <Select value={value} onValueChange={(v) => { if (v) onChange(v); }}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder="Select model" />
      </SelectTrigger>
      <SelectContent>
        {filtered.map((m) => (
          <SelectItem key={m.id} value={m.id} className="text-xs">
            <span className="flex items-center gap-1.5">
              <span className="font-medium">{m.name}</span>
              <span className="text-muted-foreground">{m.provider}</span>
              {m.supportsVision && (
                <Eye className="h-3 w-3 text-muted-foreground" />
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
