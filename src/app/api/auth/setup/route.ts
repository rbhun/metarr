import { createAccount, createSession, requestIsSecure, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const db = getDb();
  try {
    createAccount(db, username, password);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The login could not be created.";
    const status = message === "A login already exists." ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
  const session = createSession(db, true);
  const response = NextResponse.json({ ok: true, next: "/" });
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(true, requestIsSecure(request)));
  return response;
}
