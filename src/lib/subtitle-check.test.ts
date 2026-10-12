import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { rebuildCatalog } from "@/lib/catalog";
import { insertSourceRecords, migrate, queryLibrary } from "@/lib/db";
import type { FilterRule } from "@/lib/filters";
import { sourceDraft, withMedia } from "@/lib/source";
import { pruneTimingChecks, readTimingCheck, readTimingSettings, timingCounts } from "@/lib/subtitle-check/store";
import { checkVideo, libraryVideos } from "@/lib/subtitle-check/worker";
import { isClearFix } from "@/lib/subtitle-timing";

const FILM = 24000 / 1001;

function stamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function srt(cues: Array<[number, number, string]>): string {
  return cues.map(([start, end, text], index) => `${index + 1}\n${stamp(start)} --> ${stamp(end)}\n${text}\n`).join("\n");
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const rule = (value: string): FilterRule[] => [{ id: "t", field: "timing", op: "eq", value }];

function titles(db: Database.Database, value: string) {
  return queryLibrary({ kind: "all", offset: 0, limit: 50, rules: rule(value), q: "" }, db).titles;
}

test("isClearFix needs a measured video whose own frame rate matches, and an end that lands on the video end", () => {
  const video = 6523.488;
  const base = { status: "longer" as const, preset: "film-to-pal", lastEnd: 6802.186, videoSeconds: video, fps: 25, measured: true, retimed: false };
  assert.equal(isClearFix(base), true);
  assert.equal(isClearFix({ ...base, fps: FILM }), false);
  assert.equal(isClearFix({ ...base, measured: false }), false);
  assert.equal(isClearFix({ ...base, retimed: true }), false);
  assert.equal(isClearFix({ ...base, lastEnd: 6802.186 - 120 }), false);
  assert.equal(isClearFix({ ...base, status: "shorter", preset: "pal-to-film", fps: FILM }), false);
  assert.equal(isClearFix({ ...base, preset: null }), false);
});

test("timing settings check by default and leave automatic fixes off", () => {
  const db = new Database(":memory:");
  migrate(db);
  assert.deepEqual(readTimingSettings(db), { enabled: true, autoFix: false });
});

test("a timing pass flags, fixes and filters subtitle files on a real video", { skip: !hasFfmpeg() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-timing-"));
  const folder = path.join(root, "Meet the Testers (2004)");
  fs.mkdirSync(folder);
  const video = path.join(folder, "Meet the Testers (2004).mkv");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=25:duration=120", "-c:v", "libx264", "-preset", "ultrafast", video]);
  const shrink = FILM / 25;
  const filmTimed = srt([
    [60 / shrink, 62 / shrink, "First"],
    [119.5 / shrink, 120 / shrink, "Ooga booga!"],
  ]);
  const english = path.join(folder, "Meet the Testers (2004).en.srt");
  const hungarian = path.join(folder, "Meet the Testers (2004).hun.srt");
  fs.writeFileSync(english, filmTimed);
  fs.writeFileSync(hungarian, filmTimed);

  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, [
    withMedia(sourceDraft({ connector: "plex", kind: "movie", externalKey: "item:1", title: "Meet the Testers", year: 2004, imdbId: "tt0000001" }), [
      {
        container: "mkv",
        path: video,
        qualityName: null,
        resolution: "120p",
        hdr: "none",
        is3d: false,
        audioLanguages: [],
        subtitleLanguages: ["English", "Hungarian"],
        audioTracks: [],
        subtitleTracks: [
          { language: "English", placement: "external", format: "SRT", forced: false },
          { language: "Hungarian", placement: "external", format: "SRT", forced: false },
        ],
      },
    ]),
  ]);
  rebuildCatalog(db);
  assert.deepEqual(libraryVideos(db), [{ stored: video, runtimeMinutes: null }]);

  await checkVideo(db, { stored: video, runtimeMinutes: null }, "pass-1", false);
  assert.equal(readTimingCheck(db, video, path.basename(english))?.status, "longer");
  assert.equal(readTimingCheck(db, video, path.basename(english))?.preset, "film-to-pal");
  assert.equal(titles(db, "off").length, 1);
  assert.equal(titles(db, "longer").length, 1);
  assert.equal(titles(db, "shorter").length, 0);
  const track = titles(db, "off")[0]!.subtitleTracks.find((item) => item.file === english);
  assert.equal(track?.timing?.status, "longer");
  assert.equal(fs.readFileSync(english, "utf8"), filmTimed);

  // Switching automatic fixes on later still fixes files an earlier pass only flagged.
  await checkVideo(db, { stored: video, runtimeMinutes: null }, "pass-2", true);
  for (const file of [english, hungarian]) {
    const fixed = readTimingCheck(db, video, path.basename(file));
    assert.equal(fixed?.retimed, true);
    assert.ok(fixed?.autoFixedAt);
    assert.equal(fixed?.status, "fits");
    assert.match(fixed?.message ?? "", /^Fixed automatically/);
    assert.ok(fs.existsSync(`${file}.metarr-orig`));
    assert.equal(fs.readFileSync(`${file}.metarr-orig`, "utf8"), filmTimed);
    assert.match(fs.readFileSync(file, "utf8"), /00:01:59,500 --> 00:02:00,000/);
  }
  assert.equal(titles(db, "off").length, 0);
  assert.equal(titles(db, "auto").length, 1);
  assert.equal(titles(db, "retimed").length, 1);
  assert.deepEqual(timingCounts(db), { checked: 2, longer: 0, shorter: 0, retimed: 2, autoFixed: 2 });

  // A retimed file is left alone on the next pass.
  const before = fs.readFileSync(english, "utf8");
  await checkVideo(db, { stored: video, runtimeMinutes: null }, "pass-2b", true);
  assert.equal(fs.readFileSync(english, "utf8"), before);

  fs.rmSync(english);
  await checkVideo(db, { stored: video, runtimeMinutes: null }, "pass-3", false);
  assert.equal(pruneTimingChecks(db, "pass-3"), 1);
  assert.equal(timingCounts(db).checked, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
