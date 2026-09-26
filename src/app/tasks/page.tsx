import { TasksView } from "@/components/tasks-view";
import { Suspense } from "react";

export default function TasksPage() {
  return (
    <Suspense fallback={<p className="px-4 py-5 text-sm text-muted-foreground">Loading tasks…</p>}>
      <TasksView />
    </Suspense>
  );
}
