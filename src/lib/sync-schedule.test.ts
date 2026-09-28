import assert from "node:assert/strict";
import test from "node:test";
import { parseSyncInterval, syncIsDue } from "@/lib/sync-schedule";

test("a library resync is due after the chosen interval", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  assert.equal(syncIsDue(null, 6, now), true);
  assert.equal(syncIsDue("not-a-date", 6, now), true);
  assert.equal(syncIsDue("2026-09-28T07:00:00.000Z", 6, now), false);
  assert.equal(syncIsDue("2026-09-28T06:00:00.000Z", 6, now), true);
  assert.equal(syncIsDue("2026-09-27T12:00:00.000Z", 24, now), true);
});

test("the resync interval stays on an offered choice", () => {
  assert.equal(parseSyncInterval(12), 12);
  assert.equal(parseSyncInterval("1"), 1);
  assert.equal(parseSyncInterval(2), 6);
  assert.equal(parseSyncInterval(null, 24), 24);
});
