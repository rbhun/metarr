import { getDb } from "@/lib/db";
import { cleanRoots, readFolderScan, suggestedPlexFolders, writeFolderScan } from "@/lib/folder-scan";
import { loadUnreadable } from "@/lib/plex-access";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  let plexFolders: Awaited<ReturnType<typeof suggestedPlexFolders>> = [];
  try {
    plexFolders = await suggestedPlexFolders(db);
  } catch {
    plexFolders = [];
  }
  return NextResponse.json({ settings: readFolderScan(db), plexFolders, unreadable: loadUnreadable(db) });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  try {
    const current = readFolderScan(getDb());
    const settings = {
      enabled: Boolean(record.enabled),
      roots: cleanRoots(record.roots),
      repair: typeof record.repair === "boolean" ? record.repair : current.repair,
    };
    writeFolderScan(getDb(), settings);
    return NextResponse.json({ settings: readFolderScan(getDb()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save folder scan." }, { status: 400 });
  }
}
