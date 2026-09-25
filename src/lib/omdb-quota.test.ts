import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "@/lib/db";
import { markOmdbExhausted, OMDB_DAILY_LIMIT, omdbUsage, reserveOmdbRequest } from "@/lib/omdb-quota";

test("OMDb lookups stop at 1000 per UTC day", () => {
  const db = new Database(":memory:");
  migrate(db);
  const now = new Date("2026-09-25T18:00:00.000Z");
  for (let index = 0; index < OMDB_DAILY_LIMIT; index += 1) {
    assert.equal(reserveOmdbRequest(db, now), true);
  }
  assert.equal(reserveOmdbRequest(db, now), false);
  assert.equal(omdbUsage(db, now).remaining, 0);
  assert.equal(reserveOmdbRequest(db, new Date("2026-09-26T00:00:00.000Z")), true);
});

test("an OMDb limit response uses up the rest of the day", () => {
  const db = new Database(":memory:");
  migrate(db);
  const now = new Date("2026-09-25T18:00:00.000Z");
  assert.equal(reserveOmdbRequest(db, now), true);
  markOmdbExhausted(db, now);
  assert.equal(reserveOmdbRequest(db, now), false);
  assert.equal(omdbUsage(db, now).count, OMDB_DAILY_LIMIT);
});
