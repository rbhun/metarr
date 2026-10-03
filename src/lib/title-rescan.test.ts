import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rebuildCatalog } from "@/lib/catalog";
import { insertSourceRecords, migrate, queryLibrary } from "@/lib/db";
import { demoRecords } from "@/lib/demo";
import { sourceDraft } from "@/lib/source";
import { rescanTitle } from "@/lib/title-rescan";
import Database from "better-sqlite3";

test("rescanTitle re-reads a movie file and keeps the library row", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-rescan-"));
  const folder = path.join(root, "Avatar (2009)");
  fs.mkdirSync(folder);
  const file = path.join(folder, "Avatar (2009).mkv");
  fs.writeFileSync(file, "not a real mkv");
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, [
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "1",
      title: "Avatar",
      year: 2009,
      imdbId: "tt0499549",
      hasFile: true,
      path: file,
      container: "mkv",
    }),
  ]);
  rebuildCatalog(db);
  const before = queryLibrary({ kind: "all", offset: 0, limit: 50, rules: [], q: "" }, db).titles[0];
  assert.ok(before);

  const result = await rescanTitle(db, before!.id);
  assert.match(result.message, /Re-read/i);
  const after = queryLibrary({ kind: "all", offset: 0, limit: 50, rules: [], q: "" }, db).titles;
  assert.equal(after.some((title) => title.title === "Avatar" && title.year === 2009), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("demo library still loads beside the rescan helper", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, demoRecords());
  rebuildCatalog(db);
  assert.ok(queryLibrary({ kind: "all", offset: 0, limit: 50, rules: [], q: "" }, db).titles.length > 0);
});
