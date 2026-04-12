import { type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon?: LucideIcon;
  heading: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    disabledReason?: string;
  };
}

export function EmptyState({
  icon: Icon,
  heading,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {Icon && (
        <div className="mb-4 rounded-full bg-muted p-3">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
      )}
      <h3 className="text-lg font-semibold">{heading}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {description}
      </p>
      {action && (
        <Button
          className="mt-4"
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.disabled ? action.disabledReason : undefined}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
