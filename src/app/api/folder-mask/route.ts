import { checkFolderMasks } from "@/lib/folder-scan";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const pass = await checkFolderMasks(getDb());
    return NextResponse.json({
      opened: pass.opened,
      failed: pass.failed,
      remaining: pass.remaining,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not check the folders." }, { status: 400 });
  }
}
