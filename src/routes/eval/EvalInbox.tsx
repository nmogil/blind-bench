import { EmptyState } from "@/components/EmptyState";
import { Inbox } from "lucide-react";

export function EvalInbox() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyState
        icon={Inbox}
        heading="You're all caught up"
        description="New evaluations will appear here when runs complete."
      />
    </div>
  );
}
