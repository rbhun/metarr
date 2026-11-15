import fs from "fs";
import Database from "better-sqlite3";
import { TABLE_INFO, type BackupTable } from "@/lib/backup-tables";

export class BackupError extends Error {}

export type { BackupGroup, BackupTable } from "@/lib/backup-tables";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new BackupError("Unknown table.");
  return `"${name}"`;
}

function userTables(db: Database.Database): string[] {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name).filter((name) => IDENT.test(name));
}

/** Tables in this database, settings and task history first, then the library list. */
export function backupTables(db: Database.Database): BackupTable[] {
  const present = new Set(userTables(db));
  const known = TABLE_INFO.filter((table) => present.has(table.name));
  const knownNames = new Set(known.map((table) => table.name));
  const extra = [...present]
    .filter((name) => !knownNames.has(name))
    .sort()
    .map((name) => ({ name, label: name, group: "other" as const }));
  return [...known, ...extra];
}

function chosenTables(db: Database.Database, tables: string[]): { chosen: string[]; allowed: Set<string> } {
  const allowed = new Set(backupTables(db).map((table) => table.name));
  const chosen = [...new Set(tables)].filter((name) => allowed.has(name));
  if (chosen.length === 0) throw new BackupError("Choose at least one table.");
  return { chosen, allowed };
}

/** Write a SQLite file containing the chosen tables. */
export async function writeBackup(db: Database.Database, tables: string[], destPath: string): Promise<string[]> {
  const { chosen, allowed } = chosenTables(db, tables);
  fs.rmSync(destPath, { force: true });
  await db.backup(destPath);
  if (chosen.length === allowed.size) return chosen;
  const copy = new Database(destPath);
  try {
    copy.pragma("foreign_keys = OFF");
    const drop = copy.transaction(() => {
      for (const name of allowed) {
        if (!chosen.includes(name)) copy.exec(`DROP TABLE ${quoteIdent(name)}`);
      }
    });
    drop();
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
  return chosen;
}

type SqlValue = string | number | bigint | Buffer | null;

function sharedColumns(upload: Database.Database, live: Database.Database, name: string): string[] {
  const quoted = quoteIdent(name);
  const fromFile = upload.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>;
  const present = new Set((live.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>).map((column) => column.name));
  return fromFile.map((column) => column.name).filter((column) => present.has(column) && IDENT.test(column));
}

/**
 * Replace each table that exists in both databases. Tables absent from the file are left alone.
 * Foreign keys stay off so deleting titles does not cascade into episodes the file left out.
 */
export function restoreBackup(db: Database.Database, filePath: string): { restored: string[]; skipped: string[] } {
  const header = Buffer.alloc(16);
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, "r");
    const read = fs.readSync(handle, header, 0, 16, 0);
    if (read < 16 || header.toString("utf8", 0, 15) !== "SQLite format 3") throw new BackupError("That file is not a database backup.");
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("That file is not a database backup.");
  } finally {
    if (handle != null) fs.closeSync(handle);
  }

  let upload: Database.Database;
  try {
    upload = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch {
    throw new BackupError("That file is not a database backup.");
  }
  try {
    const incoming = upload
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const live = new Set(backupTables(db).map((table) => table.name));
    const restored: string[] = [];
    const skipped: string[] = [];
    const plan: Array<{ name: string; columns: string[] }> = [];
    for (const { name } of incoming) {
      if (!IDENT.test(name) || !live.has(name)) {
        skipped.push(name);
        continue;
      }
      const columns = sharedColumns(upload, db, name);
      if (columns.length === 0) {
        skipped.push(name);
        continue;
      }
      plan.push({ name, columns });
    }
    if (plan.length === 0) throw new BackupError("That file has no tables Metarr can restore.");
    db.pragma("foreign_keys = OFF");
    try {
      const apply = db.transaction(() => {
        for (const item of plan) {
          const quoted = item.columns.map(quoteIdent);
          db.prepare(`DELETE FROM ${quoteIdent(item.name)}`).run();
          const insert = db.prepare(
            `INSERT INTO ${quoteIdent(item.name)} (${quoted.join(", ")}) VALUES (${item.columns.map(() => "?").join(", ")})`,
          );
          for (const row of upload.prepare(`SELECT ${quoted.join(", ")} FROM ${quoteIdent(item.name)}`).iterate() as Iterable<Record<string, SqlValue>>) {
            insert.run(...item.columns.map((column) => row[column] ?? null));
          }
          restored.push(item.name);
        }
      });
      apply();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    return { restored, skipped };
  } finally {
    upload.close();
  }
}
