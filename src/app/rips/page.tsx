import { RipsView } from "@/components/rips-view";
import { enforceAppAccess } from "@/lib/page-guard";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function RipsPage() {
  await enforceAppAccess();
  return (
    <Suspense fallback={<p className="px-4 py-5 text-sm text-muted-foreground">Loading rips…</p>}>
      <RipsView />
    </Suspense>
  );
}
