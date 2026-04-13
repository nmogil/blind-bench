import { cn } from "@/lib/utils";

const TAGS = [
  { value: "accuracy", label: "Accuracy", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
  { value: "tone", label: "Tone", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300" },
  { value: "length", label: "Length", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  { value: "relevance", label: "Relevance", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" },
  { value: "safety", label: "Safety", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" },
  { value: "format", label: "Format", color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300" },
  { value: "clarity", label: "Clarity", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  { value: "other", label: "Other", color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
] as const;

interface FeedbackTagPickerProps {
  selectedTags: string[];
  onChange: (tags: string[]) => void;
}

export function FeedbackTagPicker({ selectedTags, onChange }: FeedbackTagPickerProps) {
  const toggle = (tag: string) => {
    if (selectedTags.includes(tag)) {
      onChange(selectedTags.filter((t) => t !== tag));
    } else {
      onChange([...selectedTags, tag]);
    }
  };

  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Feedback tags">
      {TAGS.map(({ value, label, color }) => {
        const isSelected = selectedTags.includes(value);
        return (
          <button
            key={value}
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            onClick={() => toggle(value)}
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium border transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isSelected
                ? cn(color, "border-transparent")
                : "border-border text-muted-foreground hover:bg-muted/50",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Re-export tag metadata for use in other components */
export const TAG_COLORS: Record<string, string> = Object.fromEntries(
  TAGS.map((t) => [t.value, t.color]),
);

export const TAG_LABELS: Record<string, string> = Object.fromEntries(
  TAGS.map((t) => [t.value, t.label]),
);
