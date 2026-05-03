import { Link } from "react-router-dom";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ShieldX } from "lucide-react";

export function Denied() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
      <ShieldX className="h-12 w-12 text-muted-foreground" />
      <h1 className="mt-4 text-2xl font-bold">Permission denied</h1>
      <p className="mt-2 text-muted-foreground">
        You don't have access to this resource.
      </p>
      <Link to="/" replace className={cn(buttonVariants(), "mt-4")}>
        Go home
      </Link>
    </div>
  );
}
