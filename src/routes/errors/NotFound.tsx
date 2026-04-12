import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="mt-2 text-muted-foreground">
        We couldn't find that page.
      </p>
      <Button className="mt-4" onClick={() => navigate("/")}>
        Go home
      </Button>
    </div>
  );
}
