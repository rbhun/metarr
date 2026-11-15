import {
  addressFromForwarded,
  credentialsMatch,
  createSession,
  loginThrottled,
  noteLoginFailure,
  noteLoginSuccess,
  readAccount,
  requestIsSecure,
  safeNext,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const db = getDb();
  if (!readAccount(db)) return NextResponse.json({ error: "Create a login first." }, { status: 409 });
  const body = (await request.json().catch(() => null)) as { username?: unknown; password?: unknown; remember?: unknown; next?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const remember = body?.remember === true;
  const ip = addressFromForwarded(request.headers.get("x-forwarded-for")) ?? "unknown";
  if (loginThrottled(ip)) {
    return NextResponse.json({ error: "Too many sign-in attempts. Wait a few minutes." }, { status: 429 });
  }
  if (!credentialsMatch(db, username, password)) {
    noteLoginFailure(ip);
    return NextResponse.json({ error: "The username or password is wrong." }, { status: 401 });
  }
  noteLoginSuccess(ip);
  const session = createSession(db, remember);
  const response = NextResponse.json({ ok: true, next: safeNext(typeof body?.next === "string" ? body.next : null) });
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(remember, requestIsSecure(request)));
  return response;
}
