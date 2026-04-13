import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { VersionStatusPill } from "@/components/VersionStatusPill";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";

interface Version {
  _id: string;
  versionNumber: number;
  status: string;
}

interface VersionMultiPickerProps {
  versions: Version[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
  max?: number;
}

export function VersionMultiPicker({
  versions,
  selected,
  onChange,
  max = 5,
}: VersionMultiPickerProps) {
  const [open, setOpen] = useState(false);

  const sorted = [...versions].sort(
    (a, b) => b.versionNumber - a.versionNumber,
  );

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else if (next.size < max) {
      next.add(id);
    }
    onChange(next);
  }

  const label =
    selected.size === 0
      ? "Select versions"
      : `${selected.size} version${selected.size !== 1 ? "s" : ""} selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1">
            {label}
            <ChevronDown className="h-3 w-3" />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-56 p-1">
        <div className="max-h-52 overflow-y-auto">
          {sorted.map((v) => {
            const checked = selected.has(v._id);
            const disabled = !checked && selected.size >= max;
            return (
              <button
                key={v._id}
                type="button"
                disabled={disabled}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => toggle(v._id)}
              >
                <Checkbox checked={checked} tabIndex={-1} />
                <span className="font-medium">v{v.versionNumber}</span>
                <VersionStatusPill status={v.status} />
              </button>
            );
          })}
        </div>
        {selected.size >= max && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            Maximum {max} versions
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
