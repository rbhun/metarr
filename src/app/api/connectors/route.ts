import { DEFAULT_PORT, normalizeBaseUrl, rejectUrlAsKey } from "@/lib/connectors/http";
import { listConnectors, saveConnector } from "@/lib/db";
import { CONNECTORS, type ConnectorId } from "@/lib/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ connectors: listConnectors() });
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
  if (typeof id !== "string" || !CONNECTORS.includes(id as ConnectorId)) {
    return NextResponse.json({ error: "Unknown connector." }, { status: 400 });
  }
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  const enabled = Boolean(record.enabled);
  let baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  if (baseUrl) {
    try {
      baseUrl = normalizeBaseUrl(baseUrl, DEFAULT_PORT[id as ConnectorId]);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid URL." },
        { status: 400 },
      );
    }
  }
  const keyProblem = rejectUrlAsKey(apiKey, baseUrl);
  if (keyProblem) return NextResponse.json({ error: keyProblem }, { status: 400 });
  if (enabled && (!baseUrl || !apiKey)) {
    return NextResponse.json(
      { error: "Add a base URL and key before enabling this connector." },
      { status: 400 },
    );
  }
  saveConnector({ id: id as ConnectorId, baseUrl, apiKey, enabled });
  return NextResponse.json({ connectors: listConnectors() });
}
