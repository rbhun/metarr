import { destroySession, SESSION_COOKIE } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  destroySession(getDb(), token);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
