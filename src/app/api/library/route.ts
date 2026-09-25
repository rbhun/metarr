import { clearLibrary, queryLibrary } from "@/lib/db";
import { parseRules } from "@/lib/filters";
import { getSyncStatus } from "@/lib/sync";
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
    rules: parseRules(url.searchParams.get("rules")),
    q: url.searchParams.get("q") ?? "",
    offset,
    limit,
  });
  return NextResponse.json(library);
}

export async function DELETE() {
  if (getSyncStatus().running) {
    return NextResponse.json({ error: "Wait for the sync to finish before clearing the library." }, { status: 409 });
  }
  clearLibrary();
  return NextResponse.json({ ok: true });
}
