import { type CatalogModel } from "@/hooks/useModelCatalog";
import { ModelPicker } from "@/components/ModelPicker";
import { BlindLabelBadge } from "@/components/BlindLabelBadge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Minus, Plus } from "lucide-react";

export interface SlotConfig {
  label: string;
  model: string;
  temperature: number;
}

interface SlotConfiguratorProps {
  slotConfigs: SlotConfig[];
  onChange: (configs: SlotConfig[]) => void;
  hasAttachments?: boolean;
  catalogModels?: CatalogModel[];
}

const LABELS = ["A", "B", "C", "D", "E"];

export function SlotConfigurator({
  slotConfigs,
  onChange,
  hasAttachments,
  catalogModels,
}: SlotConfiguratorProps) {
  function addSlot() {
    if (slotConfigs.length >= 5) return;
    const last = slotConfigs[slotConfigs.length - 1]!;
    onChange([
      ...slotConfigs,
      {
        label: LABELS[slotConfigs.length]!,
        model: last.model,
        temperature: last.temperature,
      },
    ]);
  }

  function removeSlot() {
    if (slotConfigs.length <= 2) return;
    onChange(slotConfigs.slice(0, -1));
  }

  function updateSlot(index: number, updates: Partial<SlotConfig>) {
    const next = slotConfigs.map((s, i) =>
      i === index ? { ...s, ...updates } : s,
    );
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {/* Slot count controls */}
      <div className="flex items-center justify-between">
        <Label className="text-xs">
          Slots ({slotConfigs.length})
        </Label>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-xs"
            onClick={removeSlot}
            disabled={slotConfigs.length <= 2}
          >
            <Minus className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={addSlot}
            disabled={slotConfigs.length >= 5}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Per-slot config cards */}
      {slotConfigs.map((config, index) => (
        <div
          key={config.label}
          className="rounded-lg border bg-muted/30 p-2.5 space-y-2"
        >
          <div className="flex items-center gap-2">
            <BlindLabelBadge label={config.label} />
            <span className="text-[10px] text-muted-foreground">
              Slot {index + 1}
            </span>
          </div>

          <div className="space-y-1.5">
            <ModelPicker
              value={config.model}
              onChange={(model) => updateSlot(index, { model })}
              hasAttachments={!!hasAttachments}
              catalogModels={catalogModels}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Temp</Label>
            <Input
              type="number"
              value={config.temperature}
              onChange={(e) =>
                updateSlot(index, {
                  temperature: Math.min(
                    2,
                    Math.max(0, parseFloat(e.target.value) || 0),
                  ),
                })
              }
              step={0.1}
              min={0}
              max={2}
              className="h-7 text-xs"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
