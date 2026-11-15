import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { getMeta, setMeta } from "@/lib/db";

export const SESSION_COOKIE = "metarr_session";
export const REMEMBER_SECONDS = 14 * 24 * 60 * 60;
export const SESSION_SECONDS = 12 * 60 * 60;

const USERNAME = "auth_username";
const PASSWORD = "auth_password";
const REQUIRED = "auth_required";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_LIMIT = 8;

export type AuthRequired = "enabled" | "local";

export type AuthAccount = {
  username: string;
  required: AuthRequired;
};

const failures = new Map<string, number[]>();

export function checkUsername(username: string): string | null {
  const value = username.trim();
  if (!value) return "Enter a username.";
  if (value.length > 64) return "Use a username of 64 characters or fewer.";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "That username is not usable.";
  return null;
}

export function checkPassword(password: string): string | null {
  if (password.length < 8) return "Use a password of at least 8 characters.";
  if (password.length > 200) return "Use a password of 200 characters or fewer.";
  return null;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (password.length > 200) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  if (Number(parts[1]) !== SCRYPT_N || Number(parts[2]) !== SCRYPT_R || Number(parts[3]) !== SCRYPT_P) return false;
  try {
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = scryptSync(password, salt, expected.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function readAccount(db: Database.Database): AuthAccount | null {
  const username = getMeta(db, USERNAME);
  const password = getMeta(db, PASSWORD);
  if (!username || !password) return null;
  return { username, required: getMeta(db, REQUIRED) === "local" ? "local" : "enabled" };
}

function storedPassword(db: Database.Database): string | null {
  return getMeta(db, PASSWORD);
}

export function createAccount(db: Database.Database, username: string, password: string): void {
  const usernameError = checkUsername(username);
  if (usernameError) throw new Error(usernameError);
  const passwordError = checkPassword(password);
  if (passwordError) throw new Error(passwordError);
  const save = db.transaction(() => {
    if (readAccount(db)) throw new Error("A login already exists.");
    setMeta(db, USERNAME, username.trim());
    setMeta(db, PASSWORD, hashPassword(password));
    setMeta(db, REQUIRED, "enabled");
  });
  save();
}

export function credentialsMatch(db: Database.Database, username: string, password: string): boolean {
  const account = readAccount(db);
  const stored = storedPassword(db);
  if (!account || !stored) return false;
  const passwordOk = verifyPassword(password, stored);
  const given = Buffer.from(username.trim());
  const expected = Buffer.from(account.username);
  const usernameOk = given.length === expected.length && timingSafeEqual(given, expected);
  return usernameOk && passwordOk;
}

export function updateAccount(
  db: Database.Database,
  input: { username: string; currentPassword: string; newPassword: string; required: AuthRequired },
  now = Date.now(),
): { error: string } | { token: string; maxAge?: number } {
  const account = readAccount(db);
  const stored = storedPassword(db);
  if (!account || !stored) return { error: "Create a login first." };
  const usernameError = checkUsername(input.username);
  if (usernameError) return { error: usernameError };
  if (input.required !== "enabled" && input.required !== "local") return { error: "Choose who must sign in." };
  const nextPassword = input.newPassword.trim() ? input.newPassword : "";
  if (nextPassword) {
    const passwordError = checkPassword(nextPassword);
    if (passwordError) return { error: passwordError };
  }
  if (!verifyPassword(input.currentPassword, stored)) return { error: "The current password is wrong." };
  const save = db.transaction(() => {
    setMeta(db, USERNAME, input.username.trim());
    if (nextPassword) setMeta(db, PASSWORD, hashPassword(nextPassword));
    setMeta(db, REQUIRED, input.required);
    db.prepare(`DELETE FROM auth_sessions`).run();
  });
  save();
  return createSession(db, true, now);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(db: Database.Database, remember: boolean, now = Date.now()): { token: string; maxAge?: number } {
  const token = randomBytes(32).toString("base64url");
  const lifetime = remember ? REMEMBER_SECONDS : SESSION_SECONDS;
  db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(now);
  db.prepare(`INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)`).run(tokenHash(token), now + lifetime * 1000);
  return remember ? { token, maxAge: REMEMBER_SECONDS } : { token };
}

export function readSession(db: Database.Database, token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const hash = tokenHash(token);
  const row = db.prepare(`SELECT expires_at FROM auth_sessions WHERE token_hash = ?`).get(hash) as { expires_at: number } | undefined;
  if (!row) return false;
  if (row.expires_at <= now) {
    db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(hash);
    return false;
  }
  return true;
}

export function destroySession(db: Database.Database, token: string | null | undefined) {
  if (!token) return;
  db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(tokenHash(token));
}

export function isLocalAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  let ip = value.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  return ip === "127.0.0.1" || ip === "::1";
}

/** The socket address Next recorded. A list of hops is ignored so a spoofed prefix is not treated as this machine. */
export function addressFromForwarded(header: string | null): string | null {
  if (!header) return null;
  const parts = header.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 1) return null;
  return parts[0] ?? null;
}

export function safeNext(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.includes("\\") || value.includes("://") || value.includes("\n") || value.includes("\r")) return "/";
  if (value.startsWith("/login") || value.startsWith("/setup")) return "/";
  return value;
}

export function loginThrottled(key: string, now = Date.now()): boolean {
  const recent = (failures.get(key) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
  if (recent.length === 0) failures.delete(key);
  else failures.set(key, recent);
  return recent.length >= FAILURE_LIMIT;
}

export function noteLoginFailure(key: string, now = Date.now()) {
  const recent = (failures.get(key) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
  recent.push(now);
  failures.set(key, recent);
}

export function noteLoginSuccess(key: string) {
  failures.delete(key);
}

export type AccessDecision =
  | { allow: true; redirectHome: boolean }
  | { allow: false; kind: "setup" | "login" };

export function decideAccess(input: {
  pathname: string;
  hasAccount: boolean;
  hasSession: boolean;
  localBypass: boolean;
}): AccessDecision {
  if (input.pathname === "/api/auth/logout") return { allow: true, redirectHome: false };
  if (!input.hasAccount) {
    if (input.pathname === "/setup" || input.pathname === "/api/auth/setup") return { allow: true, redirectHome: false };
    return { allow: false, kind: "setup" };
  }
  if (input.hasSession || input.localBypass) {
    const home = input.pathname === "/login" || input.pathname === "/setup";
    return { allow: true, redirectHome: home };
  }
  if (input.pathname === "/login" || input.pathname === "/api/auth/login") return { allow: true, redirectHome: false };
  return { allow: false, kind: "login" };
}

export function sessionCookieOptions(remember: boolean, secure: boolean) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    path: "/",
    secure,
    ...(remember ? { maxAge: REMEMBER_SECONDS } : {}),
  };
}

export function requestIsSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  return new URL(request.url).protocol === "https:";
}
