import { getSyncStatus, startSync } from "@/lib/sync";
import { CONNECTORS, type ConnectorId } from "@/lib/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSyncStatus());
}

export async function POST(request: Request) {
  const text = await request.text();
  let only: ConnectorId | undefined;
  if (text.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
    }
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
    if (id != null) {
      if (typeof id !== "string" || !CONNECTORS.includes(id as ConnectorId)) {
        return NextResponse.json({ error: "Unknown connector." }, { status: 400 });
      }
      only = id as ConnectorId;
    }
  }
  const result = startSync(only);
  return NextResponse.json(result.status, { status: result.started ? 202 : 200 });
}
