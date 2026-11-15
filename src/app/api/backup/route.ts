import fs from "fs";
import os from "os";
import path from "path";
import { BackupError, backupTables, writeBackup } from "@/lib/backup";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ tables: backupTables(getDb()) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { tables?: unknown } | null;
  const tables = Array.isArray(body?.tables) ? body.tables.filter((item): item is string => typeof item === "string") : [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-backup-"));
  const dest = path.join(dir, "backup.db");
  try {
    await writeBackup(getDb(), tables, dest);
    const bytes = fs.readFileSync(dest);
    const day = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="metarr-backup-${day}.db"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof BackupError ? error.message : "The backup could not be written.";
    return NextResponse.json({ error: message }, { status: error instanceof BackupError ? 400 : 500 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
