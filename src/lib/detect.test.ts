import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { agreeLanguage } from "@/lib/detect/agree";
import { commentaryRole } from "@/lib/detect/commentary";
import { cueText } from "@/lib/detect/cues";
import { overlayAudio, overlaySubtitles } from "@/lib/detect/overlay";
import { resolveMediaPath } from "@/lib/detect/paths";
import { plexActivitiesBusy, plexTranscodeBusy } from "@/lib/detect/plex";
import { inDetectWindow, windowKey } from "@/lib/detect/schedule";
import { claimNextJob, enqueueTargets, saveDetection } from "@/lib/detect/store";
import { targetsFromFiles, type ScanFile } from "@/lib/detect/targets";
import { assignSidecars, languageFromSubtitleName } from "@/lib/detect/sidecars";
import { detectTextLanguage } from "@/lib/detect/text-language";
import { migrate } from "@/lib/db";
import type { StoredDetection } from "@/lib/detect/store";

test("the schedule window can cross midnight", () => {
  assert.equal(inDetectWindow(1, 1, 6), true);
  assert.equal(inDetectWindow(5, 1, 6), true);
  assert.equal(inDetectWindow(6, 1, 6), false);
  assert.equal(inDetectWindow(15, 1, 6), false);
  assert.equal(inDetectWindow(23, 23, 6), true);
  assert.equal(inDetectWindow(2, 23, 6), true);
  assert.equal(inDetectWindow(12, 23, 6), false);
  assert.equal(inDetectWindow(4, 4, 4), false);
});

test("a window key stays put until the next opening", () => {
  const inside = new Date(2026, 8, 25, 2, 30, 0);
  const later = new Date(2026, 8, 25, 5, 0, 0);
  const closed = new Date(2026, 8, 25, 12, 0, 0);
  assert.equal(windowKey(inside, 1, 6), "2026-09-25T01");
  assert.equal(windowKey(later, 1, 6), windowKey(inside, 1, 6));
  assert.equal(windowKey(closed, 1, 6), null);
  const afterMidnight = new Date(2026, 8, 26, 1, 0, 0);
  assert.equal(windowKey(afterMidnight, 23, 6), "2026-09-25T23");
});

test("path mapping rewrites a plex prefix and keeps a file that is already local", () => {
  const exists = (candidate: string) => candidate === "/Volumes/media/Movies/Film.mkv";
  assert.equal(resolveMediaPath("/mnt/media/Movies/Film.mkv", [{ from: "/mnt/media", to: "/Volumes/media" }], exists), "/Volumes/media/Movies/Film.mkv");
  assert.equal(resolveMediaPath("/Volumes/media/Movies/Film.mkv", [], exists), "/Volumes/media/Movies/Film.mkv");
  assert.equal(resolveMediaPath("/data/Film.mkv", [{ from: "/mnt/media", to: "/Volumes/media" }], exists), null);
});

test("commentary comes from the track title or from how people talk about the film", () => {
  assert.equal(commentaryRole("Director Commentary", ""), "commentary");
  assert.equal(commentaryRole(null, "In this scene we shot the ending. The director wanted another take."), "commentary");
  assert.equal(commentaryRole(null, "In this scene the ship arrives."), null);
});

test("language votes need a confident majority", () => {
  assert.deepEqual(agreeLanguage([
    { language: "hu", probability: 0.91 },
    { language: "hu", probability: 0.84 },
    { language: "en", probability: 0.4 },
  ]), { language: "hu", confidence: 0.91 });
  assert.equal(agreeLanguage([
    { language: "hu", probability: 0.55 },
    { language: "en", probability: 0.52 },
  ]).language, null);
});

test("subtitle cues drop timestamps and ass styling", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nCome in.\n";
  assert.equal(cueText(srt), "Hello there. Come in.");
  const ass = "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Becsukta az ajtót.";
  assert.equal(cueText(ass), "Becsukta az ajtót.");
});

test("an untagged sidecar takes its language from the file name and is not a third subtitle", () => {
  const video = "/mnt/media/Movies/10 Things I Hate About You (1999)/10 Things I Hate About You 1999.avi";
  const names = ["10 Things I Hate About You 1999.en.srt", "10 Things I Hate About You 1999.hu.srt", "notes.txt"];
  const tracks = assignSidecars(video, [
    { language: "English", placement: "external", format: "SRT", forced: false },
    { language: null, placement: "external", format: "SRT", forced: false },
  ], names);
  assert.equal(tracks[0]?.file?.endsWith(".en.srt"), true);
  assert.equal(tracks[1]?.language, "Hungarian");
  assert.equal(tracks[1]?.file?.endsWith(".hu.srt"), true);
  assert.equal(languageFromSubtitleName("movie.you.srt"), null);
});

test("text language detection reads english and hungarian subtitles", () => {
  const english = Array(6).fill("She closed the door and walked into the kitchen while the rain started again on the empty street.").join(" ");
  const hungarian = Array(6).fill("Becsukta az ajtót, és kiment a konyhába, miközben az eső újra eleredt az üres utcán.").join(" ");
  assert.equal(detectTextLanguage(english).language, "English");
  assert.equal(detectTextLanguage(hungarian).language, "Hungarian");
  assert.equal(detectTextLanguage("Hi").language, null);
  assert.equal(detectTextLanguage("AVI LIST hdrl avih strl movi idx1 JUNK RIFF WAVE fmt data LIST INFO ISFT Lavf BPS DURATION NUMBER OF FRAMES".repeat(4)).language, null);
});

test("unknown audio and subtitles are scanned, labeled tracks and discs are not", () => {
  const file: ScanFile = {
    label: "Dune (2021)",
    path: "/movies/Dune.mkv",
    container: "mkv",
    playableLabel: "video",
    audioTracks: [
      { language: "English", layout: "5.1", codec: "DTS", streamIndex: 0 },
      { language: null, layout: "2.0", codec: "AAC", streamIndex: 1, label: "Commentary" },
    ],
    subtitleTracks: [
      { language: null, placement: "internal", format: "SRT", forced: false, streamIndex: 0 },
      { language: "English", placement: "internal", format: "SRT", forced: false, streamIndex: 1 },
      { language: null, placement: "burn-in", format: null, forced: false },
      { language: null, placement: "external", format: "SRT", forced: false, file: "/movies/Dune.hu.srt" },
    ],
    versions: [],
  };
  const disc: ScanFile = { ...file, label: "Disc", path: "/movies/Dune.iso", container: "iso", playableLabel: "disc", audioTracks: [{ language: null, layout: "5.1", codec: "AC3" }], subtitleTracks: [] };
  const targets = targetsFromFiles([file, disc], false, new Set());
  assert.deepEqual(targets.map((target) => `${target.kind}:${target.ordinal}:${target.path}`), [
    "audio:1:/movies/Dune.mkv",
    "subtitle:0:/movies/Dune.mkv",
    "subtitle:0:/movies/Dune.hu.srt",
  ]);
  const scanned = new Set(["/movies/Dune.mkv\0audio\0" + "1"]);
  const again = targetsFromFiles([file], false, scanned);
  assert.equal(again.some((target) => target.kind === "audio"), false);
  const rescan = targetsFromFiles([file], true, scanned);
  assert.equal(rescan.some((target) => target.kind === "audio"), true);
});

test("detected languages replace unknown on the matching stream", () => {
  const detections = new Map<string, StoredDetection>([["/movies/Dune.mkv\0audio\0" + "1", { language: "Hungarian", role: "commentary" }]]);
  const [first, second] = overlayAudio("/movies/Dune.mkv", [
    { language: "English", layout: "5.1", codec: "DTS", streamIndex: 0 },
    { language: null, layout: "2.0", codec: "AAC", streamIndex: 1 },
  ], detections);
  assert.equal(first?.detectedLanguage, undefined);
  assert.equal(second?.detectedLanguage, "Hungarian");
  assert.equal(second?.detectedRole, "commentary");
  const [subtitle] = overlaySubtitles("/movies/Dune.mkv", [
    { language: null, placement: "external", format: "SRT", forced: false, file: "/movies/Dune.hu.srt" },
  ], new Map([[`/movies/Dune.hu.srt\0subtitle\0${0}`, { language: "Hungarian", role: null }]]));
  assert.equal(subtitle?.detectedLanguage, "Hungarian");
});

test("immediate jobs run before queued ones, and a result is stored", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/a.mkv", kind: "audio", ordinal: 0, label: "Queued", format: null, placement: null, streamLabel: null },
  ], "window");
  enqueueTargets(db, [
    { path: "/b.mkv", kind: "subtitle", ordinal: 0, label: "Now", format: "SRT", placement: "internal", streamLabel: null },
  ], "immediate");
  const closed = claimNextJob(db, false);
  assert.equal(closed?.path, "/b.mkv");
  assert.equal(claimNextJob(db, false), null);
  const opened = claimNextJob(db, true);
  assert.equal(opened?.label, "Queued");
  if (opened) saveDetection(db, opened, { language: "Hungarian", role: null, confidence: 1, message: null });
  const row = db.prepare(`SELECT language FROM detect_results WHERE path = '/a.mkv'`).get() as { language: string };
  assert.equal(row.language, "Hungarian");
  db.close();
});

test("plex background work and transcodes count as busy", () => {
  assert.equal(plexActivitiesBusy({ MediaContainer: { size: 0 } }), false);
  assert.equal(plexActivitiesBusy({ MediaContainer: { size: 1, Activity: [{ type: "library.update" }] } }), true);
  assert.equal(plexTranscodeBusy({ MediaContainer: { Metadata: [{ title: "Dune" }] } }), false);
  assert.equal(plexTranscodeBusy({ MediaContainer: { Metadata: [{ TranscodeSession: { throttled: false } }] } }), true);
});
