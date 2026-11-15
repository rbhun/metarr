import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { addressFromForwarded, isLocalAddress, readAccount, readSession, SESSION_COOKIE } from "@/lib/auth";
import { getDb } from "@/lib/db";

/** Pages that show the library call this. The proxy is the gate for API routes. */
export async function enforceAppAccess() {
  const db = getDb();
  const account = readAccount(db);
  if (!account) redirect("/setup");
  const headerList = await headers();
  const local = account.required === "local" && isLocalAddress(addressFromForwarded(headerList.get("x-forwarded-for")));
  if (local) return;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!readSession(db, token)) redirect("/login");
}
