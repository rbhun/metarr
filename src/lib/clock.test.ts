import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyTimeZone, clockInfo, parseTimeZone, saveTimeZone } from "@/lib/clock";
import { migrate } from "@/lib/db";
import { inDetectWindow } from "@/lib/detect/schedule";

test("the time zone setting moves the schedule clock and can be cleared", () => {
  const before = process.env.TZ;
  const db = new Database(":memory:");
  migrate(db);
  assert.equal(parseTimeZone("Europe/Budapest"), "Europe/Budapest");
  assert.equal(parseTimeZone("Mars/Olympus"), null);
  assert.equal(parseTimeZone(""), null);
  const moment = new Date("2026-09-29T20:47:00Z");
  saveTimeZone(db, "Europe/Budapest");
  assert.equal(process.env.TZ, "Europe/Budapest");
  assert.deepEqual(clockInfo(db, moment), { timeZone: "Europe/Budapest", now: "22:47", setting: "Europe/Budapest" });
  assert.equal(inDetectWindow(moment.getHours(), 23, 5), false);
  saveTimeZone(db, "Asia/Tokyo");
  assert.equal(moment.getHours(), 5);
  saveTimeZone(db, null);
  assert.equal(clockInfo(db).setting, null);
  applyTimeZone(db);
  assert.equal(process.env.TZ, before);
  db.close();
});
