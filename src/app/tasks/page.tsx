import { TasksView } from "@/components/tasks-view";
import { enforceAppAccess } from "@/lib/page-guard";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  await enforceAppAccess();
  return (
    <Suspense fallback={<p className="px-4 py-5 text-sm text-muted-foreground">Loading tasks…</p>}>
      <TasksView />
    </Suspense>
  );
}
