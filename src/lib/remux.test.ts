import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { rebuildCatalog } from "@/lib/catalog";
import { plexSessionBusy } from "@/lib/detect/plex";
import type { ScanFile } from "@/lib/detect/targets";
import { insertSourceRecords, migrate, queryLibrary } from "@/lib/db";
import { titleIdForPath } from "@/lib/title-link";
import { demoRecords } from "@/lib/demo";
import { assertWritableDiscFolder, friendlyFsError, missingPathMessage, remuxWorkDirectory, unreadablePathMessage, writeAccessDeniedMessage } from "@/lib/remux/access";
import { convertedFileFor, listDiscCandidates } from "@/lib/remux/candidates";
import { discsFromFile } from "@/lib/remux/discs";
import { planRemuxFiles, safeBaseName } from "@/lib/remux/place";
import { mainTitle, parseDiscTitles, progressPercent } from "@/lib/remux/robot";
import { makemkvFailure, makemkvMessages, ripDisc, undersizedMessage } from "@/lib/remux/run";
import { prepareMakemkvLogDir, readMakemkvLog } from "@/lib/remux/logs";
import { makemkvSource, outputDirectory, resolveDiscPath } from "@/lib/remux/source";
import {
  claimNextRemux,
  clearPendingRemux,
  enqueueDiscs,
  enqueuePaths,
  finishRemux,
  hasImmediateRemux,
  KEEP_ALL_SELECTION,
  retryAllFailedRemux,
  retryFailedRemux,
  listRemuxJobs,
  readRemuxSettings,
  remuxTotals,
  writeMakeMkvHome,
  writeRemuxPause,
  writeRemuxSettings,
} from "@/lib/remux/store";
import { listTaskJobs, taskTotalsFor, taskTotalsSum } from "@/lib/tasks";

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

test("a disc counts as converted only when the title also has a playable video file", () => {
  const disc = "/movies/Film (1999)/VIDEO_TS/VIDEO_TS.VOB";
  const mkv = "/movies/Film (1999)/Film (1999).mkv";
  const dvd = { path: disc, container: "vob", playableLabel: "dvd" as const };
  const video = { path: mkv, container: "mkv", playableLabel: "video" as const };
  assert.equal(convertedFileFor({ ...dvd, versions: [dvd] }), null);
  assert.equal(convertedFileFor({ ...video, versions: [video, dvd] }), mkv);
  assert.equal(convertedFileFor({ ...dvd, versions: [dvd, { path: "/movies/Film (1999)/Film.iso", container: "iso", playableLabel: "video" }] }), null);
});

test("robot info keeps the longest title and reads progress", () => {
  const titles = parseDiscTitles(INFO);
  assert.equal(titles.length, 3);
  assert.equal(mainTitle(titles)?.index, 1);
  assert.equal(mainTitle(titles)?.seconds, 2 * 3600 + 14 * 60 + 32);
  assert.equal(progressPercent("PRGV:32768,0,65536"), 50);
  assert.equal(progressPercent("PRGV:65536,0,65536"), 100);
  assert.equal(progressPercent("MSG:1,0,0,\"hi\""), null);
});

test("disc paths become a MakeMKV source and an output folder", () => {
  assert.equal(makemkvSource("/movies/Film.iso"), "iso:/movies/Film.iso");
  assert.equal(makemkvSource("/movies/Film/BDMV/STREAM/00000.m2ts"), "file:/movies/Film");
  assert.equal(makemkvSource("/movies/Film/VIDEO_TS/VTS_01_1.VOB"), "file:/movies/Film");
  assert.equal(makemkvSource("/mnt/media/Movies/50 First Dates (2004)/VIDEO_TS/VIDEO_TS.VOB"), "file:/mnt/media/Movies/50 First Dates (2004)");
  assert.equal(makemkvSource("/movies/bdmv-extra/clip.mkv"), null);
  assert.equal(outputDirectory("/movies/Film.iso"), "/movies");
  assert.equal(outputDirectory("/movies/Film/BDMV/STREAM/00000.m2ts"), "/movies/Film");
  assert.equal(outputDirectory("/mnt/media/Movies/50 First Dates (2004)/VIDEO_TS/VIDEO_TS.VOB"), "/mnt/media/Movies/50 First Dates (2004)");
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
  assert.deepEqual(result, { added: 2, skipped: 1, already: 0, promoted: 0 });
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

test("Convert now jumps the queue and moves up a waiting disc", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueDiscs(db, [scan("Old (1990)", "/movies/Old.iso", "iso"), scan("Film (1999)", "/movies/Film.iso", "iso")], false);
  assert.equal(hasImmediateRemux(db), false);
  assert.equal(claimNextRemux(db, true), null);
  const promoted = enqueueDiscs(db, [scan("Film (1999)", "/movies/Film.iso", "iso")], false, true);
  assert.deepEqual(promoted, { added: 0, skipped: 0, already: 0, promoted: 1 });
  assert.equal(enqueueDiscs(db, [scan("Film (1999)", "/movies/Film.iso", "iso")], false, true).already, 1);
  const added = enqueuePaths(db, [{ path: "/movies/New.iso", label: "New (2020)" }], false, true);
  assert.equal(added.added, 1);
  assert.equal(hasImmediateRemux(db), true);
  assert.equal(claimNextRemux(db, true)?.label, "Film (1999)");
  assert.equal(claimNextRemux(db, true)?.label, "New (2020)");
  assert.equal(claimNextRemux(db, true), null);
  assert.equal(hasImmediateRemux(db), false);
  assert.equal(claimNextRemux(db)?.label, "Old (1990)");
  db.close();
});

test("the queue keeps every track except 3D video, and the key stays out of the response settings", () => {
  const db = new Database(":memory:");
  migrate(db);
  assert.equal(readRemuxSettings(db).enabled, true);
  assert.equal(readRemuxSettings(db).startHour, 1);
  assert.equal(readRemuxSettings(db).endHour, 7);
  writeRemuxSettings(db, { enabled: false, startHour: 1, endHour: 7, binary: "makemkvcon", licenseKey: "beta-key" });
  assert.equal(readRemuxSettings(db).enabled, false);
  assert.equal(readRemuxSettings(db).licenseKey, "beta-key");
  writeRemuxSettings(db, { startHour: 2, endHour: 8, binary: "/usr/bin/makemkvcon" });
  assert.equal(readRemuxSettings(db).enabled, false);
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

test("remux work folders stay under the database directory and missing media paths say to mount Docker", () => {
  assert.equal(remuxWorkDirectory("/app/data/library.db", 7), path.join("/app/data", "remux-work", "job-7"));
  const missing = missingPathMessage("/mnt/media/Movies/Missing Film (1999)");
  assert.match(missing, /mount the host media folder/);
  const error = Object.assign(new Error("ENOENT: no such file or directory, mkdir '/mnt/media/Movies/Film/.metarr-remux-1'"), {
    code: "ENOENT",
  });
  assert.match(friendlyFsError(error, "Remux failed."), /mount the host media folder|Missing path component|\/mnt\/media/);
  assert.match(writeAccessDeniedMessage("/mnt/media/Movies/Film"), /METARR_UID/);
  assert.match(writeAccessDeniedMessage("/mnt/media/Movies/Film", "EROFS"), /EROFS/);
  assert.match(writeAccessDeniedMessage("/mnt/media/Movies/Film", "EACCES"), /NFS|METARR_UID|write access/);
  const writable = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-write-"));
  try {
    assert.doesNotThrow(() => assertWritableDiscFolder(writable));
  } finally {
    fs.rmSync(writable, { recursive: true, force: true });
  }
});

test("paths and library discs feed the remux queue and history list", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, demoRecords());
  rebuildCatalog(db);
  const discs = listDiscCandidates(db);
  assert.ok(discs.some((disc) => disc.path.includes("/BDMV/") && disc.kind === "bluray"));
  const avatar = discs.find((disc) => disc.path.includes("/BDMV/"));
  assert.ok(avatar?.titleId);
  assert.equal(titleIdForPath(db, avatar.path), avatar.titleId);
  assert.equal(titleIdForPath(db, "/movies/Avatar (2009)/Avatar.hun.srt"), avatar.titleId);
  assert.equal(titleIdForPath(db, "/nowhere/Film.mkv"), null);
  assert.equal(titleIdForPath(db, "/movies/Unknown.mkv"), null);
  assert.equal(queryLibrary({ kind: "all", rules: [], q: "", offset: 0, limit: 1, id: avatar.titleId }, db).titles[0]?.id, avatar.titleId);
  const byPath = enqueuePaths(
    db,
    [
      { path: "/movies/Alien DVD.iso", label: "Alien (1979)" },
      { path: "/movies/NotADisc.mkv", label: "Skip" },
      { path: "/movies/Alien DVD.iso", label: "Alien (1979)" },
    ],
    false,
  );
  assert.deepEqual(byPath, { added: 1, skipped: 1, already: 1, promoted: 0 });
  const again = enqueuePaths(db, [{ path: "/movies/Alien DVD.iso" }], true);
  assert.equal(again.already, 1);
  assert.deepEqual(remuxTotals(db), { pending: 1, running: 0, done: 0, failed: 0 });
  const waiting = listRemuxJobs(db, { status: "pending", page: 1, pageSize: 50 });
  assert.equal(waiting.total, 1);
  assert.equal(waiting.jobs[0]?.label, "Alien (1979)");
  assert.equal(waiting.jobs[0]?.extras, false);
  assert.equal(clearPendingRemux(db), 1);
  assert.equal(listRemuxJobs(db, { status: "pending", page: 1, pageSize: 50 }).total, 0);
  const job = enqueuePaths(db, [{ path: "/movies/Fail.iso", label: "Fail (1999)" }], false);
  assert.equal(job.added, 1);
  const claimed = claimNextRemux(db);
  assert.ok(claimed);
  finishRemux(db, claimed.id, "failed", null);
  const failed = listRemuxJobs(db, { status: "failed", page: 1, pageSize: 10 });
  assert.equal(failed.jobs[0]?.message, "Remux failed with no further detail from MakeMKV.");
  const tasks = listTaskJobs(db, { queue: "remux", status: "failed", page: 1, pageSize: 10 });
  assert.equal(tasks.total, 1);
  assert.match(tasks.jobs[0]?.detail ?? "", /Disc remux/);
  assert.equal(taskTotalsFor(db, "remux").failed, 1);
  const pending = enqueuePaths(db, [{ path: "/movies/Wait.iso", label: "Wait (2000)" }], false);
  assert.equal(pending.added, 1);
  const all = listTaskJobs(db, { queue: "remux", status: "all", page: 1, pageSize: 20 });
  assert.equal(all.total, 2);
  assert.ok(all.jobs.some((job) => job.status === "failed"));
  assert.ok(all.jobs.some((job) => job.status === "pending"));
  assert.equal(taskTotalsSum(taskTotalsFor(db, "remux")), 2);
  assert.equal(all.jobs.find((job) => job.status === "pending")?.waiting, null);
  writeRemuxPause(db, "plex");
  const paused = listTaskJobs(db, { queue: "remux", status: "all", page: 1, pageSize: 20 });
  assert.equal(paused.jobs.find((job) => job.status === "pending")?.waiting, "Waiting: Plex is busy");
  assert.equal(paused.jobs.find((job) => job.status === "failed")?.waiting, null);
  writeRemuxPause(db, null);
  assert.equal(retryFailedRemux(db, claimed.id), "retried");
  assert.equal(listRemuxJobs(db, { status: "failed", page: 1, pageSize: 10 }).total, 0);
  assert.ok(listRemuxJobs(db, { status: "pending", page: 1, pageSize: 10 }).jobs.some((row) => row.label === "Fail (1999)"));
  db.close();
});

const ISO_START = [
  'MSG:1005,0,1,"MakeMKV v1.18.1 linux(x64-release) started","%1 started","MakeMKV v1.18.1 linux(x64-release)"',
  'MSG:2003,0,0,"The program can\'t find any usable optical drives.","The program can\'t find any usable optical drives."',
  'MSG:3007,0,0,"Using direct disc access mode","Using direct disc access mode"',
  'MSG:3025,0,0,"AACS directory not present, assuming unencrypted disc","AACS directory not present, assuming unencrypted disc"',
];

test("a MakeMKV failure shows the real reason, not the routine ISO lines", () => {
  assert.deepEqual(makemkvMessages(ISO_START.join("\n")).slice(1), [
    "The program can't find any usable optical drives.",
    "Using direct disc access mode",
    "AACS directory not present, assuming unencrypted disc",
  ]);
  const expired = [
    ...ISO_START,
    'MSG:5021,260,1,"This application version is too old. Please download the latest version at http://www.makemkv.com/ or enter a registration key to continue using the application.","%1","x"',
  ].join("\n");
  assert.match(makemkvFailure(expired, 1), /^This application version is too old\..*Blu-ray needs a MakeMKV key .*Settings → Disc remux/);
  const failed = [...ISO_START, 'MSG:5010,0,0,"Failed to open disc","Failed to open disc"'].join("\n");
  assert.equal(makemkvFailure(failed, 2), "Failed to open disc (MakeMKV exited with code 2.)");
  assert.equal(
    makemkvFailure(ISO_START.join("\n"), 1),
    "MakeMKV exited with code 1. MakeMKV gave no reason; its last message was: AACS directory not present, assuming unencrypted disc",
  );
  assert.equal(makemkvFailure("", null), "MakeMKV stopped without an exit code.");
  const profile = [...ISO_START, 'MSG:1011,0,1,"Profile parsing error: default profile missing, using builtin default","%1","x"'].join("\n");
  assert.match(makemkvFailure(profile, null, "SIGSEGV"), /^MakeMKV crashed \(SIGSEGV\)\. .*update Metarr so it installs 1\.18\.4.*last message was: Profile parsing error/);
  assert.match(makemkvFailure("", null, "SIGKILL"), /ran out of memory/);
});

test("MakeMKV logs are kept per job under the data folder and old ones are pruned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-mkvlog-"));
  const dbName = path.join(dir, "metarr.db");
  for (let id = 1; id <= 32; id += 1) prepareMakemkvLogDir(dbName, id);
  const jobs = fs.readdirSync(path.join(dir, "makemkv-logs"));
  assert.equal(jobs.length, 30);
  assert.ok(!jobs.includes("job-1") && !jobs.includes("job-2"));
  assert.equal(readMakemkvLog(dbName, 32), null);
  const log = prepareMakemkvLogDir(dbName, 32)!;
  fs.writeFileSync(path.join(log, "info-output.txt"), "MSG:1005,0,1,\"hello\"\n");
  assert.match(readMakemkvLog(dbName, 32) ?? "", /===== info-output.txt =====\nMSG:1005/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a MakeMKV crash still leaves its output and debug log for the job", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-mkvcrash-"));
  const fake = path.join(dir, "makemkvcon");
  fs.writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'echo "debug line" >> "$HOME/MakeMKV_log.txt"',
      'echo \'MSG:3007,0,0,"AACS directory not present, assuming unencrypted disc","x"\'',
      "kill -SEGV $$",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "MakeMKV_log.txt"), "stale\n");
  const logDir = prepareMakemkvLogDir(path.join(dir, "metarr.db"), 7)!;
  await assert.rejects(
    ripDisc({
      binary: fake,
      source: "iso:/nowhere.iso",
      outputDir: dir,
      workDir: path.join(dir, "work"),
      label: "Disc",
      extras: false,
      home: dir,
      logDir,
      onProgress: () => undefined,
    }),
    /SIGSEGV/,
  );
  const text = readMakemkvLog(path.join(dir, "metarr.db"), 7) ?? "";
  assert.match(text, /info-output.txt[\s\S]*AACS directory not present[\s\S]*\[stopped by SIGSEGV\]/);
  assert.match(text, /info-debug.txt =====\ndebug line/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Redo all brings back each failed disc once and leaves converted discs alone", () => {
  const db = new Database(":memory:");
  migrate(db);
  const fail = (filePath: string) => {
    enqueuePaths(db, [{ path: filePath, label: "Disc" }], false);
    const job = claimNextRemux(db);
    assert.ok(job);
    finishRemux(db, job.id, "failed", "boom");
    return job.id;
  };
  for (let i = 0; i < 6; i += 1) fail("/movies/First Dates.iso");
  const latest = fail("/movies/Other.iso");
  fail("/movies/Done.iso");
  enqueuePaths(db, [{ path: "/movies/Done.iso", label: "Disc" }], false);
  const done = claimNextRemux(db);
  assert.ok(done);
  finishRemux(db, done.id, "done", null);
  assert.equal(retryAllFailedRemux(db), 2);
  const pending = listRemuxJobs(db, { status: "pending", page: 1, pageSize: 50 }).jobs;
  assert.deepEqual(pending.map((job) => job.path).sort(), ["/movies/First Dates.iso", "/movies/Other.iso"]);
  assert.ok(pending.some((job) => job.id === latest));
  assert.equal(retryAllFailedRemux(db), 0);
  db.close();
});

test("a DVD whose listed VOB is gone still opens from its VIDEO_TS folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-dvd-"));
  const videoTs = path.join(dir, "Movies", "A Walk in the Clouds (1995)", "VIDEO_TS");
  fs.mkdirSync(videoTs, { recursive: true });
  const exists = (candidate: string) => fs.existsSync(candidate);
  const listed = path.join(videoTs, "VIDEO_TS.VOB");
  const local = resolveDiscPath(listed, [], exists);
  assert.equal(local, listed);
  assert.equal(makemkvSource(local!), `file:${path.dirname(videoTs)}`);
  const plexPath = "/data/Movies/A Walk in the Clouds (1995)/VIDEO_TS/VIDEO_TS.VOB";
  assert.equal(resolveDiscPath(plexPath, [{ from: "/data", to: dir }], exists), listed);
  assert.equal(resolveDiscPath(path.join(dir, "Gone.iso"), [], exists), null);
  assert.equal(resolveDiscPath(path.join(dir, "Movies", "Gone (2000)", "VIDEO_TS", "VIDEO_TS.VOB"), [], exists), null);
  assert.match(
    unreadablePathMessage(path.join(dir, "Movies", "Gone (2000)", "VIDEO_TS", "VIDEO_TS.VOB")),
    /^Gone \(2000\) is not in .*Movies\. It was moved, renamed or removed/,
  );
  assert.match(unreadablePathMessage("/nowhere-metarr/Movies/x.iso"), /\/nowhere-metarr does not exist inside Metarr/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the feature is the largest title, even when a small clip reports a longer duration", () => {
  const info = [
    'TINFO:0,9,0,"2:19:01"',
    'TINFO:0,11,0,"34359738368"',
    'TINFO:0,16,0,"00010.mpls"',
    'TINFO:95,9,0,"26:30:12"',
    'TINFO:95,11,0,"189792256"',
    'TINFO:95,16,0,"00377.m2ts"',
    'TINFO:7,9,0,"0:01:30"',
    'TINFO:7,11,0,"104857600"',
  ].join("\n");
  const titles = parseDiscTitles(info);
  const main = mainTitle(titles);
  assert.equal(main?.index, 0);
  assert.equal(main?.sourceFile, "00010.mpls");
  assert.equal(main?.bytes, 34359738368);
  assert.equal(undersizedMessage(main!, 30 * 1024 **3), null);
  assert.match(
    undersizedMessage(main!, 181 * 1024 ** 2) ?? "",
    /^MakeMKV saved only 181 MB of the 32\.0 GB title 0 \(00010\.mpls\), so nothing was saved next to the disc\./,
  );
  assert.equal(undersizedMessage({ ...main!, bytes: 0 }, 1), null);
});
