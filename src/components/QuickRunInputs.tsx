import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Variable {
  _id: string;
  name: string;
  defaultValue?: string;
  required: boolean;
}

interface QuickRunInputsProps {
  variables: Variable[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

export function QuickRunInputs({ variables, values, onChange }: QuickRunInputsProps) {
  if (variables.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No variables defined. The prompt will be sent as-is.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {variables.map((v) => (
        <div key={v._id}>
          <Label className="text-xs">
            {v.name}
            {v.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          <Input
            value={values[v.name] ?? ""}
            onChange={(e) =>
              onChange({ ...values, [v.name]: e.target.value })
            }
            placeholder={v.defaultValue || `Enter ${v.name}...`}
            className="h-8 text-sm mt-0.5"
          />
        </div>
      ))}
    </div>
  );
}
