import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { rebuildCatalog } from "@/lib/catalog";
import { plexSessionBusy } from "@/lib/detect/plex";
import type { ScanFile } from "@/lib/detect/targets";
import { insertSourceRecords, migrate } from "@/lib/db";
import { demoRecords } from "@/lib/demo";
import { listDiscCandidates } from "@/lib/remux/candidates";
import { discsFromFile } from "@/lib/remux/discs";
import { planRemuxFiles, safeBaseName } from "@/lib/remux/place";
import { longestTitle, parseDiscTitles, progressPercent } from "@/lib/remux/robot";
import { makemkvSource, outputDirectory } from "@/lib/remux/source";
import {
  claimNextRemux,
  clearPendingRemux,
  enqueueDiscs,
  enqueuePaths,
  KEEP_ALL_SELECTION,
  listRemuxJobs,
  readRemuxSettings,
  remuxTotals,
  writeMakeMkvHome,
  writeRemuxSettings,
} from "@/lib/remux/store";

const INFO = `
TINFO:0,9,0,"0:02:11"
TINFO:0,27,0,"Logo_t00.mkv"
TINFO:1,9,0,"2:14:32"
TINFO:1,27,0,"Film_t01.mkv"
TINFO:2,9,0,"0:18:04"
TINFO:2,27,0,"Extra_t02.mkv"
PRGV:32768,0,65536
`;

function scan(label: string, filePath: string | null, container: string | null): ScanFile {
  return {
    label,
    path: filePath,
    container,
    playableLabel: "iso",
    audioTracks: [],
    subtitleTracks: [],
    versions: [],
  };
}

test("robot info keeps the longest title and reads progress", () => {
  const titles = parseDiscTitles(INFO);
  assert.equal(titles.length, 3);
  assert.equal(longestTitle(titles)?.index, 1);
  assert.equal(longestTitle(titles)?.seconds, 2 * 3600 + 14 * 60 + 32);
  assert.equal(progressPercent("PRGV:32768,0,65536"), 50);
  assert.equal(progressPercent("PRGV:65536,0,65536"), 100);
  assert.equal(progressPercent("MSG:1,0,0,\"hi\""), null);
});

test("disc paths become a MakeMKV source and an output folder", () => {
  assert.equal(makemkvSource("/movies/Film.iso"), "iso:/movies/Film.iso");
  assert.equal(makemkvSource("/movies/Film/BDMV/STREAM/00000.m2ts"), "file:/movies/Film");
  assert.equal(makemkvSource("/movies/Film/VIDEO_TS/VTS_01_1.VOB"), "file:/movies/Film");
  assert.equal(makemkvSource("/movies/bdmv-extra/clip.mkv"), null);
  assert.equal(outputDirectory("/movies/Film.iso"), "/movies");
  assert.equal(outputDirectory("/movies/Film/BDMV/STREAM/00000.m2ts"), "/movies/Film");
});

test("the longest file is the movie and other titles get Plex extra names", () => {
  assert.equal(safeBaseName('Film: "Two" / Three'), "Film Two Three");
  const produced = [
    { path: "/tmp/logo.mkv", bytes: 5 },
    { path: "/tmp/film.mkv", bytes: 50 },
    { path: "/tmp/extra.mkv", bytes: 20 },
  ];
  const movieOnly = planRemuxFiles("/out", "Film (1999)", produced, false, () => false);
  assert.equal(movieOnly.main.from, "/tmp/film.mkv");
  assert.equal(movieOnly.main.to, path.join("/out", "Film (1999).mkv"));
  assert.equal(movieOnly.extras.length, 0);
  const withExtras = planRemuxFiles("/out", "Film (1999)", produced, true, (file) => file.endsWith(`${path.sep}Film (1999)-other.mkv`));
  assert.deepEqual(
    withExtras.extras.map((item) => path.basename(item.to)),
    ["Film (1999)-other2.mkv", "Film (1999)-other3.mkv"],
  );
  assert.throws(() => planRemuxFiles("/out", "Film (1999)", produced, false, () => true), /already exists/);
});

test("only disc images join the queue, one after another", () => {
  const db = new Database(":memory:");
  migrate(db);
  const result = enqueueDiscs(
    db,
    [
      scan("Film (1999)", "/movies/Film.iso", "iso"),
      scan("Show", "/tv/Show.mkv", "mkv"),
      scan("Disc (2001)", "/movies/Disc/BDMV/STREAM/00000.m2ts", "m2ts"),
    ],
    true,
  );
  assert.deepEqual(result, { added: 2, skipped: 1, already: 0 });
  assert.equal(discsFromFile(scan("Show", "/tv/Show.mkv", "mkv")).length, 0);
  const again = enqueueDiscs(db, [scan("Film (1999)", "/movies/Film.iso", "iso")], false);
  assert.equal(again.already, 1);
  assert.equal(again.added, 0);
  const first = claimNextRemux(db);
  assert.equal(first?.path, "/movies/Film.iso");
  assert.equal(first?.extras, true);
  assert.equal(claimNextRemux(db)?.label, "Disc (2001)");
  assert.equal(claimNextRemux(db), null);
  db.close();
});

test("the queue keeps every track except 3D video, and the key stays out of the response settings", () => {
  const db = new Database(":memory:");
  migrate(db);
  assert.equal(readRemuxSettings(db).startHour, 1);
  assert.equal(readRemuxSettings(db).endHour, 7);
  writeRemuxSettings(db, { startHour: 1, endHour: 7, binary: "makemkvcon", licenseKey: "beta-key" });
  assert.equal(readRemuxSettings(db).licenseKey, "beta-key");
  writeRemuxSettings(db, { startHour: 2, endHour: 8, binary: "/usr/bin/makemkvcon" });
  assert.equal(readRemuxSettings(db).licenseKey, "beta-key");
  assert.equal(readRemuxSettings(db).binary, "/usr/bin/makemkvcon");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-makemkv-"));
  try {
    writeMakeMkvHome(home, "beta-key");
    const conf = fs.readFileSync(path.join(home, ".MakeMKV", "settings.conf"), "utf8");
    assert.match(conf, new RegExp(KEEP_ALL_SELECTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(conf, /app_MinimumTitleLength = "0"/);
    assert.match(conf, /app_Key = "beta-key"/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  db.close();
});

test("a direct play counts as Plex being busy", () => {
  assert.equal(plexSessionBusy({ MediaContainer: { size: 1, Metadata: [{ title: "Film" }] } }), true);
  assert.equal(plexSessionBusy({ MediaContainer: { size: 0 } }), false);
});

test("paths and library discs feed the remux queue and history list", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, demoRecords());
  rebuildCatalog(db);
  const discs = listDiscCandidates(db);
  assert.ok(discs.some((disc) => disc.path.includes("/BDMV/") && disc.kind === "bluray"));
  const byPath = enqueuePaths(
    db,
    [
      { path: "/movies/Alien DVD.iso", label: "Alien (1979)" },
      { path: "/movies/NotADisc.mkv", label: "Skip" },
      { path: "/movies/Alien DVD.iso", label: "Alien (1979)" },
    ],
    false,
  );
  assert.deepEqual(byPath, { added: 1, skipped: 1, already: 1 });
  const again = enqueuePaths(db, [{ path: "/movies/Alien DVD.iso" }], true);
  assert.equal(again.already, 1);
  assert.deepEqual(remuxTotals(db), { pending: 1, running: 0, done: 0, failed: 0 });
  const waiting = listRemuxJobs(db, { status: "pending", page: 1, pageSize: 50 });
  assert.equal(waiting.total, 1);
  assert.equal(waiting.jobs[0]?.label, "Alien (1979)");
  assert.equal(waiting.jobs[0]?.extras, false);
  assert.equal(clearPendingRemux(db), 1);
  assert.equal(listRemuxJobs(db, { status: "pending", page: 1, pageSize: 50 }).total, 0);
  db.close();
});
