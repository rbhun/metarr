import { listProviders, saveProvider } from "@/lib/db";
import { omdbUsage } from "@/lib/omdb-quota";
import { PROVIDERS, type ProviderId } from "@/lib/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ providers: listProviders(), omdb: omdbUsage() });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = record.id;
  if (typeof id !== "string" || !PROVIDERS.includes(id as ProviderId)) {
    return NextResponse.json({ error: "Unknown online source." }, { status: 400 });
  }
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  const enabled = Boolean(record.enabled);
  if (enabled && !apiKey) {
    return NextResponse.json({ error: "Add an API key before enabling this source." }, { status: 400 });
  }
  saveProvider({ id: id as ProviderId, apiKey, enabled });
  return NextResponse.json({ providers: listProviders() });
}
