import { LibraryView } from "@/components/library-view";
import { queryLibrary } from "@/lib/db";
import { enforceAppAccess } from "@/lib/page-guard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await enforceAppAccess();
  const initial = queryLibrary({
    kind: "all",
    rules: [],
    q: "",
    offset: 0,
    limit: 50,
  });
  return <LibraryView initial={initial} />;
}
