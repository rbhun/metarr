import { MergeView } from "@/components/merge-view";
import { Suspense } from "react";

export default function MergePage() {
  return (
    <Suspense fallback={<p className="px-4 py-5 text-sm text-muted-foreground">Loading merge…</p>}>
      <MergeView />
    </Suspense>
  );
}
