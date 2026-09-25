import { testConnector } from "@/lib/connectors/test";
import { recordConnectorTest } from "@/lib/db";
import { CONNECTORS, type ConnectorId } from "@/lib/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = record.id;
  if (typeof id !== "string" || !CONNECTORS.includes(id as ConnectorId)) {
    return NextResponse.json({ error: "Unknown connector." }, { status: 400 });
  }
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl : "";
  const apiKey = typeof record.apiKey === "string" ? record.apiKey : "";
  try {
    const message = await testConnector(id as ConnectorId, baseUrl, apiKey);
    recordConnectorTest(id as ConnectorId, true, message);
    return NextResponse.json({ ok: true, message });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed.";
    recordConnectorTest(id as ConnectorId, false, message);
    return NextResponse.json({ ok: false, message }, { status: 400 });
  }
}
