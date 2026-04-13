import { MODELS } from "@/lib/models";
import { type CatalogModel } from "@/hooks/useModelCatalog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye } from "lucide-react";

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  hasAttachments?: boolean;
  catalogModels?: CatalogModel[];
}

function formatPrice(perMillion: number): string {
  if (perMillion === 0) return "free";
  if (perMillion < 0.01) return "<$0.01";
  return `$${perMillion.toFixed(2)}`;
}

export function ModelPicker({
  value,
  onChange,
  hasAttachments,
  catalogModels,
}: ModelPickerProps) {
  // Use catalog models when available, fall back to hardcoded
  const allModels: CatalogModel[] = catalogModels && catalogModels.length > 0
    ? catalogModels
    : MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        contextWindow: m.contextWindow,
        supportsVision: m.supportsVision,
        promptPricing: 0,
        completionPricing: 0,
      }));

  const filtered = hasAttachments
    ? allModels.filter((m) => m.supportsVision)
    : allModels;

  // Group by provider
  const grouped = new Map<string, CatalogModel[]>();
  for (const m of filtered) {
    const group = grouped.get(m.provider) ?? [];
    group.push(m);
    grouped.set(m.provider, group);
  }

  const hasPricing = catalogModels && catalogModels.length > 0;

  return (
    <Select value={value} onValueChange={(v) => { if (v) onChange(v); }}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder="Select model" />
      </SelectTrigger>
      <SelectContent>
        {Array.from(grouped.entries()).map(([provider, models]) => (
          <SelectGroup key={provider}>
            <SelectLabel className="text-xs font-semibold text-muted-foreground">
              {provider}
            </SelectLabel>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id} className="text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="font-medium">{m.name}</span>
                  {m.supportsVision && (
                    <Eye className="h-3 w-3 text-muted-foreground" />
                  )}
                  {hasPricing && (m.promptPricing > 0 || m.completionPricing > 0) && (
                    <span className="text-[10px] text-muted-foreground">
                      {formatPrice(m.promptPricing)}/{formatPrice(m.completionPricing)}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
