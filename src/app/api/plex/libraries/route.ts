import { fetchPlexLibraries } from "@/lib/connectors/plex";
import { listConnectors, plexExcludedLibraries, savePlexExcludedLibraries } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const plex = listConnectors().find((connector) => connector.id === "plex");
  if (!plex?.baseUrl.trim() || !plex.apiKey.trim()) {
    return NextResponse.json({ error: "Save a Plex URL and token first." }, { status: 400 });
  }
  try {
    const libraries = await fetchPlexLibraries(plex.baseUrl, plex.apiKey);
    const excluded = new Set(plexExcludedLibraries());
    return NextResponse.json({
      libraries: libraries.map((library) => ({ ...library, included: !excluded.has(library.key) })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Plex libraries could not be loaded.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const excluded = Array.isArray(record.excluded)
    ? record.excluded.filter((item): item is string => typeof item === "string")
    : null;
  if (!excluded) return NextResponse.json({ error: "Expected a list of libraries to skip." }, { status: 400 });
  savePlexExcludedLibraries(excluded);
  return NextResponse.json({ excluded: plexExcludedLibraries() });
}
