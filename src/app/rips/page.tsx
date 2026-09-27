import { RipsView } from "@/components/rips-view";
import { Suspense } from "react";

export default function RipsPage() {
  return (
    <Suspense fallback={<p className="px-4 py-5 text-sm text-muted-foreground">Loading rips…</p>}>
      <RipsView />
    </Suspense>
  );
}
