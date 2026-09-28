import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { hasFormatRefresh, queueFormatRefresh } from "@/lib/detect/format-refresh";
import { getMeta, migrate, setMeta } from "@/lib/db";

test("a file is asked once for a format the apps can read from the stream", () => {
  const db = new Database(":memory:");
  migrate(db);
  queueFormatRefresh(db, ["/movies/Film.mkv", "/movies/Film.mkv"]);
  assert.equal(hasFormatRefresh(db), true);
  assert.deepEqual(JSON.parse(getMeta(db, "format_refresh_queue") ?? "[]"), ["/movies/Film.mkv"]);
  setMeta(db, "format_refresh_done", JSON.stringify(["/movies/Film.mkv"]));
  queueFormatRefresh(db, ["/movies/film.mkv", "/movies/Other.mkv"]);
  assert.deepEqual(JSON.parse(getMeta(db, "format_refresh_queue") ?? "[]"), ["/movies/Film.mkv", "/movies/Other.mkv"]);
});
