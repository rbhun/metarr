import { LibraryView } from "@/components/library-view";
import { queryLibrary } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const initial = queryLibrary({
    kind: "all",
    rules: [],
    q: "",
    offset: 0,
    limit: 50,
  });
  return <LibraryView initial={initial} />;
}
