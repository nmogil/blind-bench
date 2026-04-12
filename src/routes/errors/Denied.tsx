import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ShieldX } from "lucide-react";

export function Denied() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
      <ShieldX className="h-12 w-12 text-muted-foreground" />
      <h1 className="mt-4 text-2xl font-bold">Permission denied</h1>
      <p className="mt-2 text-muted-foreground">
        You don't have access to this resource.
      </p>
      <Button variant="outline" className="mt-4" onClick={() => navigate(-1)}>
        Go back
      </Button>
    </div>
  );
}
