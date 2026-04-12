import { Outlet } from "react-router-dom";
import { TopBar } from "@/components/TopBar";

export function EvalLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar variant="evaluator" />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
