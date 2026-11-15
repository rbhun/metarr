import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  addressFromForwarded,
  checkPassword,
  checkUsername,
  createAccount,
  createSession,
  credentialsMatch,
  decideAccess,
  destroySession,
  hashPassword,
  isLocalAddress,
  loginThrottled,
  noteLoginFailure,
  noteLoginSuccess,
  readAccount,
  readSession,
  safeNext,
  updateAccount,
  verifyPassword,
} from "@/lib/auth";
import { migrate } from "@/lib/db";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-auth-"));
  const db = new Database(path.join(dir, "library.db"));
  migrate(db);
  return db;
}

test("a password hash verifies only that password", () => {
  const stored = hashPassword("correct-horse");
  assert.equal(verifyPassword("correct-horse", stored), true);
  assert.equal(verifyPassword("wrong-horse", stored), false);
  assert.equal(verifyPassword("correct-horse", "scrypt$1$1$1$aa$bb"), false);
  assert.equal(checkPassword("short"), "Use a password of at least 8 characters.");
  assert.equal(checkPassword("long-enough"), null);
  assert.equal(checkUsername("  "), "Enter a username.");
  assert.equal(checkUsername("ada"), null);
});

test("the first login can be created once and then signs in", () => {
  const db = tempDb();
  assert.equal(readAccount(db), null);
  createAccount(db, " ada ", "correct-horse");
  assert.deepEqual(readAccount(db), { username: "ada", required: "enabled" });
  assert.throws(() => createAccount(db, "ada", "correct-horse"), /already exists/);
  assert.equal(credentialsMatch(db, "ada", "correct-horse"), true);
  assert.equal(credentialsMatch(db, "ada", "wrong-horse"), false);
  assert.equal(credentialsMatch(db, "other", "correct-horse"), false);
  const session = createSession(db, false, 1_000);
  assert.equal(readSession(db, session.token, 1_000), true);
  assert.equal("maxAge" in session, false);
  assert.equal(readSession(db, session.token, 1_000 + 12 * 60 * 60 * 1000), false);
  const remembered = createSession(db, true, 1_000);
  assert.equal(remembered.maxAge, 14 * 24 * 60 * 60);
  destroySession(db, remembered.token);
  assert.equal(readSession(db, remembered.token, 1_000), false);
});

test("changing the login requires the current password and drops old sessions", () => {
  const db = tempDb();
  createAccount(db, "ada", "correct-horse");
  const session = createSession(db, true, 1_000);
  const denied = updateAccount(db, { username: "ada", currentPassword: "nope-nope", newPassword: "", required: "enabled" }, 1_000);
  assert.deepEqual(denied, { error: "The current password is wrong." });
  assert.equal(readSession(db, session.token, 1_000), true);
  const saved = updateAccount(
    db,
    { username: "grace", currentPassword: "correct-horse", newPassword: "new-secret", required: "local" },
    2_000,
  );
  assert.equal("token" in saved, true);
  assert.equal(readSession(db, session.token, 2_000), false);
  assert.equal(credentialsMatch(db, "grace", "new-secret"), true);
  assert.deepEqual(readAccount(db), { username: "grace", required: "local" });
});

test("local addresses are the machine itself, and a hop list is not", () => {
  assert.equal(isLocalAddress("127.0.0.1"), true);
  assert.equal(isLocalAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLocalAddress("::1"), true);
  assert.equal(isLocalAddress("192.168.1.20"), false);
  assert.equal(isLocalAddress("172.18.0.1"), false);
  assert.equal(addressFromForwarded("127.0.0.1"), "127.0.0.1");
  assert.equal(addressFromForwarded("127.0.0.1, 10.0.0.8"), null);
  assert.equal(addressFromForwarded(null), null);
});

test("the next page stays inside this app", () => {
  assert.equal(safeNext(null), "/");
  assert.equal(safeNext("/settings"), "/settings");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("/login"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
});

test("pages and APIs stay closed until there is a session", () => {
  assert.deepEqual(decideAccess({ pathname: "/api/connectors", hasAccount: false, hasSession: false, localBypass: false }), {
    allow: false,
    kind: "setup",
  });
  assert.deepEqual(decideAccess({ pathname: "/setup", hasAccount: false, hasSession: false, localBypass: false }), {
    allow: true,
    redirectHome: false,
  });
  assert.deepEqual(decideAccess({ pathname: "/", hasAccount: true, hasSession: false, localBypass: false }), {
    allow: false,
    kind: "login",
  });
  assert.deepEqual(decideAccess({ pathname: "/api/auth/login", hasAccount: true, hasSession: false, localBypass: false }), {
    allow: true,
    redirectHome: false,
  });
  assert.deepEqual(decideAccess({ pathname: "/api/connectors", hasAccount: true, hasSession: true, localBypass: false }), {
    allow: true,
    redirectHome: false,
  });
  assert.deepEqual(decideAccess({ pathname: "/login", hasAccount: true, hasSession: true, localBypass: false }), {
    allow: true,
    redirectHome: true,
  });
  assert.deepEqual(decideAccess({ pathname: "/", hasAccount: true, hasSession: false, localBypass: true }), {
    allow: true,
    redirectHome: false,
  });
  assert.deepEqual(decideAccess({ pathname: "/api/auth/logout", hasAccount: true, hasSession: false, localBypass: false }), {
    allow: true,
    redirectHome: false,
  });
});

test("sign-in attempts from one address stop after eight failures", () => {
  const key = `limit-${Date.now()}`;
  assert.equal(loginThrottled(key, 5_000), false);
  for (let i = 0; i < 8; i += 1) noteLoginFailure(key, 5_000);
  assert.equal(loginThrottled(key, 5_000), true);
  noteLoginSuccess(key);
  assert.equal(loginThrottled(key, 5_000), false);
});
