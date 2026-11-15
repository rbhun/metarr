import fs from "fs";
import os from "os";
import path from "path";
import { BackupError, restoreBackup } from "@/lib/backup";
import { getDb } from "@/lib/db";
import { getSyncStatus } from "@/lib/sync";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 1024 * 1024 * 1024;

export async function POST(request: Request) {
  if (getSyncStatus().running) {
    return NextResponse.json({ error: "Wait for the sync to finish before restoring." }, { status: 409 });
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: "Choose a backup file." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "That backup is too large." }, { status: 400 });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-restore-"));
  const dest = path.join(dir, "upload.db");
  try {
    fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
    const result = restoreBackup(getDb(), dest);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof BackupError ? error.message : "The backup could not be restored.";
    return NextResponse.json({ error: message }, { status: error instanceof BackupError ? 400 : 500 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
