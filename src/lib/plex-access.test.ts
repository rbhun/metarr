import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { rebuildCatalog } from "@/lib/catalog";
import { insertSourceRecords, migrate, setMeta } from "@/lib/db";
import { listVideos, passFolderMasks, readFolderScan, writeFolderScan } from "@/lib/folder-scan";
import { noteForBlocks, PLEX_UNREADABLE_KEY, type PlexAccount } from "@/lib/plex-access";
import { sourceDraft } from "@/lib/source";

const other: PlexAccount = { uid: null, gids: [] };

test("a folder closed to everyone else is reported, and an open one is not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-plex-access-"));
  fs.chmodSync(root, 0o755);
  const closed = path.join(root, "Glass Tiger (2001)");
  const open = path.join(root, "Glass Tiger 3 (2010)");
  const lockedFile = path.join(open, "private.mkv");
  const readable = path.join(open, "film.mkv");
  fs.mkdirSync(closed);
  fs.mkdirSync(open);
  fs.writeFileSync(path.join(closed, "film.mkv"), "x");
  fs.writeFileSync(lockedFile, "x");
  fs.writeFileSync(readable, "x");
  fs.chmodSync(closed, 0o2700);
  fs.chmodSync(lockedFile, 0o600);
  fs.chmodSync(readable, 0o644);
  try {
    const blocked = new Set<string>();
    const found = listVideos(root, { blocked, account: other });
    assert.equal(blocked.has(closed), true);
    assert.equal(blocked.has(lockedFile), true);
    assert.equal(blocked.has(open), false);
    assert.equal(blocked.has(readable), false);
    assert.ok(found.includes(readable));
    assert.equal(
      noteForBlocks([path.join(closed, "film.mkv"), readable], [...blocked]),
      "Plex cannot read Glass Tiger (2001).",
    );
  } finally {
    fs.chmodSync(closed, 0o755);
    fs.chmodSync(lockedFile, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the owner can read a private folder when that is the Plex account", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-plex-owner-"));
  fs.chmodSync(root, 0o755);
  const folder = path.join(root, "Film (1999)");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "film.mkv"), "x");
  fs.chmodSync(folder, 0o700);
  fs.chmodSync(path.join(folder, "film.mkv"), 0o600);
  try {
    const blocked = new Set<string>();
    listVideos(root, { blocked, account: { uid: process.getuid?.() ?? 0, gids: [process.getgid?.() ?? 0] } });
    assert.equal(blocked.size, 0);
    const strangers = new Set<string>();
    listVideos(root, { blocked: strangers, account: other });
    assert.equal(strangers.has(folder), true);
  } finally {
    fs.chmodSync(folder, 0o755);
    fs.chmodSync(path.join(folder, "film.mkv"), 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a closed folder is opened and the check that follows is clear", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-plex-repair-"));
  fs.chmodSync(root, 0o755);
  const folder = path.join(root, "Glass Tiger (2001)");
  const file = path.join(folder, "film.mkv");
  fs.mkdirSync(folder);
  fs.writeFileSync(file, "x");
  fs.chmodSync(folder, 0o700);
  fs.chmodSync(file, 0o600);
  const db = new Database(":memory:");
  migrate(db);
  try {
    const pass = await passFolderMasks(db, [root], true, other);
    assert.equal(pass.failed.length, 0);
    assert.equal(pass.remaining.length, 0);
    assert.ok(pass.opened.some((item) => item.endsWith("Glass Tiger (2001)")));
    assert.equal(fs.statSync(folder).mode & 0o007, 0o005);
    assert.equal(fs.statSync(file).mode & 0o004, 0o004);
    assert.equal(readFolderScan(db).repair, true);
    writeFolderScan(db, { enabled: true, roots: [root], repair: false });
    assert.equal(readFolderScan(db).repair, false);
  } finally {
    fs.chmodSync(folder, 0o755);
    fs.chmodSync(file, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a saved blocked folder shows on the title", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, [
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "1",
      title: "Glass Tiger",
      year: 2001,
      hasFile: true,
      path: "/mnt/media/Movies/Glass Tiger (2001)/UVEGTIGRIS.ISO",
      container: "iso",
    }),
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "3",
      title: "Glass Tiger 3",
      year: 2010,
      hasFile: true,
      path: "/mnt/media/Movies/Glass Tiger 3 (2010)/film.mkv",
      container: "mkv",
    }),
  ]);
  setMeta(db, PLEX_UNREADABLE_KEY, JSON.stringify(["/mnt/media/Movies/Glass Tiger (2001)"]));
  rebuildCatalog(db);
  const rows = db.prepare(`SELECT title, playable_note FROM catalog_titles ORDER BY title`).all() as Array<{ title: string; playable_note: string | null }>;
  assert.equal(rows.find((row) => row.title === "Glass Tiger")?.playable_note, "Not listed in Plex. Plex cannot read Glass Tiger (2001).");
  assert.equal(rows.find((row) => row.title === "Glass Tiger 3")?.playable_note, "Not listed in Plex");
});
