import { queryLibrary } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam === "movie" || kindParam === "series" ? kindParam : "all";
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
  const library = queryLibrary({
    kind,
    missing: url.searchParams.get("missing") === "1",
    notInPlex: url.searchParams.get("notInPlex") === "1",
    notPlayable: url.searchParams.get("notPlayable") === "1",
    missingEnglish: url.searchParams.get("missingEnglish") === "1",
    only3d: url.searchParams.get("only3d") === "1",
    hungarian: url.searchParams.get("hungarian") === "1",
    q: url.searchParams.get("q") ?? "",
    offset,
    limit,
  });
  return NextResponse.json(library);
}
