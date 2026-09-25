import { normalizeBaseUrl } from "@/lib/connectors/http";
import { getDb, getMeta, setMeta } from "@/lib/db";
import { titleLanguage } from "@/lib/title-language";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function preferences(db = getDb()) {
  return {
    titleLanguage: titleLanguage(getMeta(db, "title_language")),
    fileBrowserUrl: getMeta(db, "file_browser_url"),
    fileBrowserRoot: getMeta(db, "file_browser_root"),
  };
}

export async function GET() {
  return NextResponse.json(preferences());
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const db = getDb();
  if ("titleLanguage" in record) {
    setMeta(db, "title_language", titleLanguage(typeof record.titleLanguage === "string" ? record.titleLanguage : ""));
  }
  if ("fileBrowserUrl" in record) {
    const raw = typeof record.fileBrowserUrl === "string" ? record.fileBrowserUrl.trim() : "";
    if (!raw) {
      setMeta(db, "file_browser_url", "");
    } else {
      try {
        setMeta(db, "file_browser_url", normalizeBaseUrl(raw, 8080));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Enter a File Browser URL.";
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }
  }
  if ("fileBrowserRoot" in record) {
    const root = typeof record.fileBrowserRoot === "string" ? record.fileBrowserRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "") : "";
    setMeta(db, "file_browser_root", root);
  }
  return NextResponse.json(preferences(db));
}
