import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { BackupError, backupTables, restoreBackup, writeBackup } from "@/lib/backup";
import { defaultBackupNames } from "@/lib/backup-tables";
import { migrate } from "@/lib/db";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-backup-"));
  const db = new Database(path.join(dir, "library.db"));
  migrate(db);
  return { dir, db };
}

function tableNames(file: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

test("the default backup is settings and task history, and All tables adds the library", () => {
  const { db } = tempDb();
  const tables = backupTables(db);
  const names = new Set(defaultBackupNames(tables));
  assert.equal(names.has("connectors"), true);
  assert.equal(names.has("detect_jobs"), true);
  assert.equal(names.has("detect_results"), true);
  assert.equal(names.has("catalog_titles"), false);
  assert.equal(tables.some((table) => table.name === "catalog_titles" && table.group === "library"), true);
  db.close();
});

test("a backup keeps the chosen tables and a failure message", async () => {
  const { dir, db } = tempDb();
  db.prepare(`UPDATE connectors SET base_url = ? WHERE id = 'plex'`).run("http://plex:32400");
  db.prepare(
    `INSERT INTO detect_jobs (path, kind, ordinal, priority, status, label, message, created_at, finished_at)
     VALUES ('/m/Film.mkv', 'audio', 0, 'window', 'failed', 'Film', 'No speech found in the sample.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z')`,
  ).run();
  const dest = path.join(dir, "partial.db");
  const written = await writeBackup(db, ["connectors", "detect_jobs", "not_a_table"], dest);
  assert.deepEqual(written.sort(), ["connectors", "detect_jobs"]);
  assert.deepEqual(tableNames(dest), ["connectors", "detect_jobs"]);
  const copy = new Database(dest, { readonly: true });
  const url = copy.prepare(`SELECT base_url FROM connectors WHERE id = 'plex'`).get() as { base_url: string };
  const job = copy.prepare(`SELECT message FROM detect_jobs`).get() as { message: string };
  copy.close();
  assert.equal(url.base_url, "http://plex:32400");
  assert.equal(job.message, "No speech found in the sample.");
  db.close();
});

test("restore replaces tables from the file and leaves the others", async () => {
  const source = tempDb();
  source.db.prepare(`UPDATE connectors SET base_url = ? WHERE id = 'plex'`).run("http://plex:32400");
  source.db.prepare(
    `INSERT INTO remux_jobs (path, label, status, message, created_at, finished_at)
     VALUES ('/m/Disc', 'Disc', 'done', 'Remuxed.', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')`,
  ).run();
  const file = path.join(source.dir, "carry.db");
  await writeBackup(source.db, ["connectors", "remux_jobs"], file);

  const target = tempDb();
  target.db.prepare(`UPDATE connectors SET base_url = ? WHERE id = 'plex'`).run("http://old:32400");
  target.db.prepare(`INSERT INTO catalog_titles (kind, title, sort_title, playable_label) VALUES ('movie', 'Keep', 'keep', 'video')`).run();
  target.db.prepare(
    `INSERT INTO detect_jobs (path, kind, ordinal, priority, status, label, created_at)
     VALUES ('/m/Other.mkv', 'audio', 0, 'window', 'failed', 'Other', '2026-01-02T00:00:00.000Z')`,
  ).run();

  const result = restoreBackup(target.db, file);
  assert.equal(result.restored.includes("connectors"), true);
  assert.equal(result.restored.includes("remux_jobs"), true);
  const url = target.db.prepare(`SELECT base_url FROM connectors WHERE id = 'plex'`).get() as { base_url: string };
  const title = target.db.prepare(`SELECT title FROM catalog_titles`).get() as { title: string };
  const kept = target.db.prepare(`SELECT label FROM detect_jobs`).get() as { label: string };
  const remux = target.db.prepare(`SELECT message FROM remux_jobs`).get() as { message: string };
  assert.equal(url.base_url, "http://plex:32400");
  assert.equal(title.title, "Keep");
  assert.equal(kept.label, "Other");
  assert.equal(remux.message, "Remuxed.");
  source.db.close();
  target.db.close();
});

test("restore of an empty table clears that table", async () => {
  const source = tempDb();
  const file = path.join(source.dir, "empty-jobs.db");
  await writeBackup(source.db, ["detect_jobs"], file);
  const target = tempDb();
  target.db.prepare(
    `INSERT INTO detect_jobs (path, kind, ordinal, priority, status, label, created_at)
     VALUES ('/m/Film.mkv', 'audio', 0, 'window', 'done', 'Film', '2026-01-01T00:00:00.000Z')`,
  ).run();
  restoreBackup(target.db, file);
  const count = target.db.prepare(`SELECT COUNT(*) AS count FROM detect_jobs`).get() as { count: number };
  assert.equal(count.count, 0);
  source.db.close();
  target.db.close();
});

test("a backup with no known table is refused", async () => {
  const { db } = tempDb();
  await assert.rejects(writeBackup(db, ["not_a_table"], path.join(os.tmpdir(), "unused.db")), BackupError);
  db.close();
});

test("a file that is not a database is refused", () => {
  const { dir, db } = tempDb();
  const file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "not a database");
  assert.throws(() => restoreBackup(db, file), BackupError);
  db.close();
});
