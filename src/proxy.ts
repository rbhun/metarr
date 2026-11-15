import {
  addressFromForwarded,
  decideAccess,
  isLocalAddress,
  readAccount,
  readSession,
  safeNext,
  SESSION_COOKIE,
} from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextResponse, type NextRequest } from "next/server";

function deny(request: NextRequest, kind: "login" | "setup") {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const error = kind === "setup" ? "Create a login first." : "Sign in.";
    return NextResponse.json({ error }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = kind === "setup" ? "/setup" : "/login";
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.search = kind === "login" && next !== "/" ? `?next=${encodeURIComponent(safeNext(next))}` : "";
  return NextResponse.redirect(url);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const db = getDb();
  const account = readAccount(db);
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const decision = decideAccess({
    pathname,
    hasAccount: account !== null,
    hasSession: readSession(db, token),
    localBypass: account?.required === "local" && isLocalAddress(addressFromForwarded(request.headers.get("x-forwarded-for"))),
  });
  if (!decision.allow) return deny(request, decision.kind);
  if (!decision.redirectHome) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
