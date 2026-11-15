import { readAccount, requestIsSecure, SESSION_COOKIE, sessionCookieOptions, updateAccount, type AuthRequired } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const account = readAccount(getDb());
  if (!account) return NextResponse.json({ error: "Create a login first." }, { status: 401 });
  return NextResponse.json({ username: account.username, required: account.required });
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    username?: unknown;
    currentPassword?: unknown;
    newPassword?: unknown;
    required?: unknown;
  } | null;
  const required: AuthRequired = body?.required === "local" ? "local" : "enabled";
  const result = updateAccount(getDb(), {
    username: typeof body?.username === "string" ? body.username : "",
    currentPassword: typeof body?.currentPassword === "string" ? body.currentPassword : "",
    newPassword: typeof body?.newPassword === "string" ? body.newPassword : "",
    required,
  });
  if ("error" in result) {
    const status = result.error === "The current password is wrong." ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json({ ok: true, username: typeof body?.username === "string" ? body.username.trim() : "", required });
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(true, requestIsSecure(request)));
  return response;
}
