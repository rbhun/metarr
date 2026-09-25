import { getDb, listConnectors } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const catalogId = Number(id);
  if (!Number.isInteger(catalogId) || catalogId <= 0) {
    return new NextResponse(null, { status: 404 });
  }
  const row = getDb().prepare(`SELECT poster_path FROM catalog_titles WHERE id = ?`).get(catalogId) as
    | { poster_path: string | null }
    | undefined;
  const posterPath = row?.poster_path;
  if (!posterPath || !posterPath.startsWith("/library/")) {
    return new NextResponse(null, { status: 404 });
  }
  const plex = listConnectors().find((connector) => connector.id === "plex");
  if (!plex?.baseUrl || !plex.apiKey) return new NextResponse(null, { status: 404 });
  let upstream: Response;
  try {
    const url = new URL(posterPath, plex.baseUrl.endsWith("/") ? plex.baseUrl : `${plex.baseUrl}/`);
    upstream = await fetch(url, {
      headers: { "X-Plex-Token": plex.apiKey, Accept: "image/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) return new NextResponse(null, { status: 502 });
  const type = upstream.headers.get("content-type") || "image/jpeg";
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": type.startsWith("image/") ? type : "image/jpeg",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
