import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const countBadgeVariants = cva(
  "inline-flex items-center justify-center rounded-md font-mono tabular-nums text-[10px] leading-none px-1.5 py-0.5 min-w-[1.25rem] h-[1.125rem] select-none",
  {
    variants: {
      variant: {
        default: "bg-muted text-muted-foreground",
        subtle: "bg-secondary text-secondary-foreground",
        accent: "bg-[var(--bg-primary-tint)] text-primary",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

interface CountBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof countBadgeVariants> {
  count: number;
}

export function CountBadge({
  count,
  variant,
  className,
  ...props
}: CountBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(countBadgeVariants({ variant }), className)}
      aria-label={`${count}`}
      {...props}
    >
      {count > 999 ? "999+" : count}
    </span>
  );
}

export { countBadgeVariants };
