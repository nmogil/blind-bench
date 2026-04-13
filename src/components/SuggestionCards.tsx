import { type SlotConfig } from "@/components/SlotConfigurator";
import { BlindLabelBadge } from "@/components/BlindLabelBadge";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

interface Suggestion {
  title: string;
  description: string;
  slotConfigs: Array<{
    label: string;
    model: string;
    temperature: number;
  }>;
}

interface SuggestionCardsProps {
  suggestions: Suggestion[];
  onApply: (configs: SlotConfig[]) => void;
}

export function SuggestionCards({ suggestions, onApply }: SuggestionCardsProps) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-medium text-muted-foreground uppercase">
        Suggested configurations
      </p>
      {suggestions.map((suggestion, i) => (
        <div
          key={i}
          className="rounded-lg border bg-card p-2.5 space-y-2 hover:border-primary/50 transition-colors"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{suggestion.title}</p>
              <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">
                {suggestion.description}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 h-6 px-2 text-[10px]"
              onClick={() => onApply(suggestion.slotConfigs)}
            >
              <Check className="h-3 w-3 mr-1" />
              Apply
            </Button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {suggestion.slotConfigs.map((sc) => (
              <div
                key={sc.label}
                className="flex items-center gap-1 text-[10px] text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5"
              >
                <BlindLabelBadge label={sc.label} />
                <span className="font-mono truncate max-w-[80px]">
                  {sc.model.split("/").pop()}
                </span>
                <span>T={sc.temperature}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
