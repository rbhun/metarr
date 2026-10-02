import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { agreeLanguage } from "@/lib/detect/agree";
import { commentaryRole } from "@/lib/detect/commentary";
import { cueCount, cueText } from "@/lib/detect/cues";
import { isForcedCueCount } from "@/lib/detect/forced";
import { overlayAudio, overlaySubtitles } from "@/lib/detect/overlay";
import { resolveMediaPath, subtitleStem } from "@/lib/detect/paths";
import { plexActivitiesBusy, plexTranscodeBusy } from "@/lib/detect/plex";
import { finishedStatus } from "@/lib/detect/worker";
import { inDetectWindow, windowKey } from "@/lib/detect/schedule";
import { claimNextJob, clearJobs, clearPendingJobs, enqueueTargets, finishJob, hasUncheckedTags, hasUnwritten, listJobs, markTagChecked, markWritten, readDetectPause, reopenForWrite, retryAllFailedJobs, retryFailedJob, saveDetection, writeDetectPause } from "@/lib/detect/store";
import { listTaskJobs } from "@/lib/tasks";
import { targetsFromFiles, type ScanFile } from "@/lib/detect/targets";
import { audioCodecFromName, languageFromAudioName } from "@/lib/detect/audio-name";
import { assignSidecars, audioSidecarTracks, FOLDER_ONLY_AUDIO, languageFromSubtitleName, sidecarTracks, withAudioSidecars } from "@/lib/detect/sidecars";
import { crossCheckAudio, folderOnlySubtitleNote, markSubtitlePresence, PLEX_ONLY_SUBTITLE, plexReadsSidecar, reconcileSubtitles } from "@/lib/media";
import type { SubtitleTrack } from "@/lib/types";
import { rollupSubtitles } from "@/lib/detect/rollup";
import { audioTargets, subtitleTargets } from "@/lib/detect/track";
import { decodeSubtitleBytes } from "@/lib/detect/encoding";
import { readPgsImages, scaleBitmap } from "@/lib/detect/pgs";
import { audioClipArgs, audioCopyArgs, audioPid, audioSliceArgs, clipStart, dialogueMix, isExceptionallyShortClip, isShortSpan, languageFromProbeTags, markerWindow, openingWindow, pcmIsSilent, pidActivity, sampleOffsets, tsWindow, wavSeconds } from "@/lib/detect/audio";
import { commandFailureText, queueUnlabeledRecognition, recognizedWrites, writeFinding } from "@/lib/detect/apply";
import { fileOmitsSavedLanguage, planTag, retargetPath } from "@/lib/detect/tag";
import { stampLanguage } from "@/lib/detect/stamp";
import { playerIdsForPaths, unreadSidecars } from "@/lib/detect/publish";
import { cueSampleStarts, pgsCopyArgs, pgsDemuxArgs, pgsSliceArgs, vobsubCanvasSize, vobsubExtractArgs } from "@/lib/detect/picture";
import { subtitleSampleIsText } from "@/lib/detect/subtitle-name";
import { detectTextLanguage } from "@/lib/detect/text-language";
import { audioLines, shownLanguage, subtitleNote } from "@/lib/format";
import { migrate } from "@/lib/db";
import type { StoredDetection } from "@/lib/detect/store";

test("the schedule window can cross midnight", () => {
  assert.equal(inDetectWindow(1, 1, 6), true);
  assert.equal(inDetectWindow(2, 1, 6), true);
  assert.equal(inDetectWindow(5, 1, 6), true);
  assert.equal(inDetectWindow(0, 1, 6), false);
  assert.equal(inDetectWindow(6, 1, 6), false);
  assert.equal(inDetectWindow(15, 1, 6), false);
  assert.equal(inDetectWindow(23, 23, 6), true);
  assert.equal(inDetectWindow(2, 23, 6), true);
  assert.equal(inDetectWindow(12, 23, 6), false);
  assert.equal(inDetectWindow(4, 4, 4), false);
});

test("a language pause reason is shown on waiting window jobs", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/film.mkv", kind: "subtitle", ordinal: 0, label: "Film", format: "PGS", placement: "internal", streamLabel: null },
  ], "window");
  writeDetectPause(db, "window");
  assert.equal(readDetectPause(db), "window");
  const listed = listTaskJobs(db, { queue: "language", status: "pending", page: 1, pageSize: 50 });
  assert.equal(listed.jobs[0]?.waiting, "Waiting for the window");
  writeDetectPause(db, "plex");
  assert.equal(listTaskJobs(db, { queue: "language", status: "pending", page: 1, pageSize: 50 }).jobs[0]?.waiting, "Waiting: Plex is busy");
  writeDetectPause(db, "write");
  assert.equal(listTaskJobs(db, { queue: "language", status: "pending", page: 1, pageSize: 50 }).jobs[0]?.waiting, "Waiting: writing a language into a file");
  writeDetectPause(db, null);
  assert.equal(listTaskJobs(db, { queue: "language", status: "pending", page: 1, pageSize: 50 }).jobs[0]?.waiting, null);
  db.close();
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

test("subtitle stems ignore language tags and year brackets so a renamed sidecar still matches", () => {
  assert.equal(subtitleStem("10 Things I Hate About You 1999.srt"), subtitleStem("10 Things I Hate About You (1999).en.srt"));
  assert.equal(subtitleStem("Film.hu.forced.srt"), subtitleStem("Film.srt"));
  assert.notEqual(subtitleStem("Film.srt"), subtitleStem("Other.srt"));
});

test("commentary comes from the track title or from how people talk about the film", () => {
  assert.equal(commentaryRole("Director Commentary", ""), "commentary");
  assert.equal(commentaryRole(null, "In this scene we shot the ending. The director wanted another take."), "commentary");
  assert.equal(commentaryRole(null, "We shot this on the lot."), "commentary");
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
  assert.equal(agreeLanguage([
    { language: "en", probability: 0.91 },
    { language: "hu", probability: 0.84 },
  ]).language, null);
  assert.deepEqual(agreeLanguage([{ language: "hu", probability: 0.91 }]), { language: "hu", confidence: 0.91 });
});

test("subtitle cues drop timestamps and ass styling", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nCome in.\n";
  assert.equal(cueText(srt), "Hello there. Come in.");
  const ass = "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Becsukta az ajtót.";
  assert.equal(cueText(ass), "Becsukta az ajtót.");
  assert.equal(cueCount(srt), 2);
  assert.equal(isForcedCueCount(12, 6_636), true);
  assert.equal(isForcedCueCount(800, 6_636), false);
  assert.equal(isForcedCueCount(12, 90), false);
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

function mergedWithScan(video: string, plex: SubtitleTrack[], scanned: SubtitleTrack[]): SubtitleTrack[] {
  const base = { container: "mkv", path: video, qualityName: null, resolution: "1080p", hdr: "none" as const, is3d: false, audioLanguages: [], subtitleLanguages: [] };
  const merged = reconcileSubtitles({ ...base, origin: "plex", subtitleTracks: plex }, { ...base, origin: "file", subtitleTracks: scanned });
  return markSubtitlePresence({ ...base, subtitleTracks: merged, presence: { plex: true, file: true } }).subtitleTracks ?? [];
}

test("the folder scan marks an external subtitle Plex lists with no file beside the video as Plex only", () => {
  const video = "/mnt/media/Movies/21 (2008)/refined-21.mkv";
  const plex: SubtitleTrack[] = [{ language: "English", placement: "external", format: "SRT", forced: false }];
  const tracks = mergedWithScan(video, plex, sidecarTracks(video, ["refined-21.mkv", "poster.jpg"]));
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]?.sources?.file, null);
  assert.equal(tracks[0]?.conflict, PLEX_ONLY_SUBTITLE);
  assert.equal(subtitleNote(tracks[0]!), "SRT · external · Plex only");
  assert.equal(assignSidecars(video, tracks, ["refined-21.mkv", "other.srt"])[0]?.file, undefined);
  const onDisk = mergedWithScan(
    video,
    [{ ...plex[0]!, file: "/data/Movies/21 (2008)/refined-21.en.srt" }],
    sidecarTracks(video, ["refined-21.mkv", "refined-21.en.srt"]),
  );
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0]?.file, "/mnt/media/Movies/21 (2008)/refined-21.en.srt");
  assert.equal(onDisk[0]?.sources?.file, "English");
  assert.equal(onDisk[0]?.conflict, undefined);
  assert.equal(subtitleNote(onDisk[0]!), "SRT · external");
});

test("subtitle files in the folder that Plex does not list are shown as their own rows", () => {
  const video = "/mnt/media/Movies/Heat (1995)/Heat (1995).mkv";
  const names = [
    "Heat (1995).mkv",
    "Heat (1995).en.srt",
    "Heat (1995).hu.forced.srt",
    "Heat (1995).idx",
    "Heat (1995).sub",
    "Heat.1995.de.srt",
    "Heat (1995) Extended.mkv",
    "Heat (1995) Extended.en.srt",
  ];
  const plex: SubtitleTrack[] = [{ language: "English", placement: "external", format: "SRT", forced: false, file: "/mnt/media/Movies/Heat (1995)/Heat (1995).en.srt" }];
  const tracks = mergedWithScan(video, plex, sidecarTracks(video, names));
  const extras = tracks.filter((track) => track.folderOnly);
  assert.deepEqual(extras.map((track) => path.basename(track.file!)).sort(), ["Heat (1995).hu.forced.srt", "Heat (1995).idx"]);
  const hungarian = extras.find((track) => track.language === "Hungarian");
  assert.equal(hungarian?.forced, true);
  assert.equal(hungarian?.sources?.plex, null);
  assert.equal(hungarian?.sources?.file, "Hungarian");
  assert.equal(hungarian?.conflict, folderOnlySubtitleNote(video, hungarian!.file!, "Hungarian", true));
  assert.match(hungarian!.conflict!, /asks Plex to refresh/);
  assert.equal(subtitleNote(hungarian!), "SRT · external · not in Plex · forced");
  assert.equal(extras.find((track) => track.format === "VobSub")?.language, null);
  assert.equal(tracks.filter((track) => !track.folderOnly)[0]?.file?.endsWith("Heat (1995).en.srt"), true);
  assert.equal(tracks.filter((track) => !track.folderOnly)[0]?.conflict, undefined);
  assert.deepEqual(unreadSidecars([{ path: video, subtitleTracks: JSON.stringify(tracks), versions: "[]" }]).map((item) => path.basename(item.file)).sort(), [
    "Heat (1995).hu.forced.srt",
    "Heat (1995).idx",
  ]);
});

test("a subtitle file Plex will not read by name says what name Plex expects", () => {
  const video = "/mnt/media/Movies/21 (2008)/refined-21.mkv";
  const tracks = mergedWithScan(video, [], sidecarTracks(video, ["refined-21.mkv", "21.2008.hu.srt"]));
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]?.folderOnly, true);
  assert.equal(plexReadsSidecar(video, tracks[0]!.file!), false);
  assert.match(tracks[0]!.conflict!, /"refined-21\.hun\.srt"/);
  assert.deepEqual(unreadSidecars([{ path: video, subtitleTracks: JSON.stringify(tracks), versions: null }]), []);
});

test("an external subtitle with no path is not queued against the video file", () => {
  const file: ScanFile = {
    label: "21 (2008)",
    path: "/mnt/media/Movies/21 (2008)/refined-21.mkv",
    container: "mkv",
    playableLabel: "video",
    audioTracks: [],
    subtitleTracks: [{ language: null, placement: "external", format: "SRT", forced: false }],
    versions: [],
  };
  assert.deepEqual(targetsFromFiles([file], false, new Set()), []);
  assert.deepEqual(subtitleTargets(file.path, file.subtitleTracks[0]!, 0, file.label), []);
});

test("a differently named video still picks up a sidecar that shares the title stem", () => {
  const video = "/mnt/media/Movies/21 (2008)/21 (2008).mkv";
  const names = ["21 (2008).mkv", "21 2008.en.srt", "notes.txt"];
  const tracks = assignSidecars(video, [{ language: null, placement: "external", format: "SRT", forced: false }], names);
  assert.equal(tracks[0]?.file?.endsWith("21 2008.en.srt"), true);
  assert.equal(tracks[0]?.language, "English");
  const release = "/mnt/media/Movies/21 (2008)/refined-21.mkv";
  const releaseTracks = assignSidecars(
    release,
    [{ language: null, placement: "external", format: "SRT", forced: false }],
    ["refined-21.mkv", "refined-21.srt"],
  );
  assert.equal(releaseTracks[0]?.file?.endsWith("refined-21.srt"), true);
});

test("a stale bare Plex subtitle path rematches language-tagged sidecars and skips detection", () => {
  const video = "/mnt/media/Movies/10 Things I Hate About You (1999)/10 Things I Hate About You 1999.avi";
  const names = [
    "10 Things I Hate About You 1999.avi",
    "10 Things I Hate About You 1999.hun.srt",
    "10 Things I Hate About You 1999.en.hi.srt",
  ];
  const tracks = assignSidecars(
    video,
    [
      { language: null, placement: "external", format: "SRT", forced: false, file: `${path.dirname(video)}/10 Things I Hate About You 1999.srt` },
      { language: null, placement: "external", format: "SRT", forced: false },
    ],
    names,
  );
  assert.equal(tracks[0]?.language, "English");
  assert.equal(tracks[0]?.file?.endsWith(".en.hi.srt"), true);
  assert.equal(tracks[1]?.language, "Hungarian");
  assert.equal(tracks[1]?.file?.endsWith(".hun.srt"), true);
  const file: ScanFile = {
    label: "10 Things I Hate About You (1999)",
    path: video,
    container: "avi",
    playableLabel: "video",
    audioTracks: [],
    subtitleTracks: tracks,
    versions: [],
  };
  assert.deepEqual(targetsFromFiles([file], false, new Set()), []);
});

test("a magyar label takes the hungarian sidecar and the unnamed file stays readable", () => {
  const video = "/mnt/media/Movies/All That Jazz (1979)/All That Jazz[1979]_TroyAtwood.avi";
  const names = [
    "All That Jazz[1979]_TroyAtwood.srt",
    "All That Jazz[1979]_TroyAtwood.en.srt",
    "All That Jazz[1979]_TroyAtwood.hu.srt",
  ];
  const tracks = assignSidecars(video, [
    { language: null, placement: "external", format: "SRT", forced: false },
    { language: "English", placement: "external", format: "SRT", forced: false },
    { language: "Magyar", placement: "external", format: "SRT", forced: false },
  ], names);
  assert.equal(tracks[1]?.file?.endsWith(".en.srt"), true);
  assert.equal(tracks[2]?.file?.endsWith(".hu.srt"), true);
  assert.equal(tracks[2]?.language, "Magyar");
  assert.equal(tracks[0]?.language, null);
  assert.equal(tracks[0]?.file?.endsWith("TroyAtwood.srt"), true);
});

test("a hungarian subtitle with a different name still belongs to that video", () => {
  const video = "/mnt/media/Movies/Crank - High Voltage (2009)/Crank 2 High Voltage 2009 (1080p x265 Joy).mkv";
  const names = ["Crank 2 High Voltage 2009 (1080p x265 Joy).mkv", "Crank.2.High.Voltage.2009.HUN.srt"];
  const tracks = assignSidecars(video, [
    { language: "English", placement: "internal", format: "PGS", forced: false, streamIndex: 0 },
    { language: "Magyar", placement: "external", format: "SRT", forced: false },
  ], names);
  assert.equal(tracks[1]?.file?.endsWith("HUN.srt"), true);
  assert.equal(shownLanguage(tracks[1]!), "Hungarian");
  const crowded = assignSidecars(video, [
    { language: "Magyar", placement: "external", format: "SRT", forced: false },
  ], ["Other Movie.mkv", "Crank.2.High.Voltage.2009.HUN.srt"]);
  assert.equal(crowded[0]?.file, undefined);
});

test("a subtitle in the subs folder is the external file", () => {
  const video = "/mnt/media/Movies/Ace Ventura - Pet Detective (1994)/hrt-avpd.1994.1080p.mkv";
  const tracks = assignSidecars(video, [
    { language: null, placement: "external", format: "SRT", forced: false },
  ], ["hrt-avpd.1994.1080p.mkv", "subs/hrt-avpd.1994.1080p.srt"]);
  assert.equal(tracks[0]?.file, "/mnt/media/Movies/Ace Ventura - Pet Detective (1994)/subs/hrt-avpd.1994.1080p.srt");
  const named = assignSidecars(video, [
    { language: null, placement: "external", format: "SRT", forced: false },
  ], ["subs/Ace Ventura.srt"]);
  assert.equal(named[0]?.file?.endsWith("subs/Ace Ventura.srt"), true);
});

test("a separate ac3 beside the video or in an audio folder is listed as not in Plex", () => {
  assert.equal(languageFromAudioName("Film.hu.ac3"), "Hungarian");
  assert.equal(audioCodecFromName("Film.hu.ac3"), "Dolby Digital");
  assert.equal(audioCodecFromName("Film.eac3"), "Dolby Digital Plus");
  const video = "/movies/Heat (1995)/Heat (1995).mkv";
  const beside = audioSidecarTracks(video, ["Heat (1995).mkv", "Heat (1995).hu.ac3", "Heat (1995).en.srt"]);
  assert.equal(beside.length, 1);
  assert.equal(beside[0]?.language, "Hungarian");
  assert.equal(beside[0]?.codec, "Dolby Digital");
  assert.equal(beside[0]?.file, "/movies/Heat (1995)/Heat (1995).hu.ac3");
  assert.equal(beside[0]?.folderOnly, true);
  assert.equal(beside[0]?.conflict, FOLDER_ONLY_AUDIO);
  const nested = audioSidecarTracks(video, ["Heat (1995).mkv", "audio/Heat (1995).en.ac3"]);
  assert.equal(nested[0]?.file, "/movies/Heat (1995)/audio/Heat (1995).en.ac3");
  assert.equal(nested[0]?.language, "English");
  const plex = [{ language: "English", layout: "5.1", codec: "DTS" }];
  const checked = crossCheckAudio(plex, [
    { language: "English", layout: "5.1", codec: "DTS", fromFile: true },
    ...beside,
  ]);
  assert.equal(checked.length, 2);
  assert.equal(checked[0]?.language, "English");
  assert.equal(checked[0]?.folderOnly, undefined);
  assert.equal(checked[1]?.folderOnly, true);
  assert.equal(checked[1]?.sources?.plex, null);
  const merged = withAudioSidecars(video, plex, ["Heat (1995).mkv", "Heat (1995).hu.ac3"]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1]?.file?.endsWith("Heat (1995).hu.ac3"), true);
  assert.equal(
    withAudioSidecars(video, checked, ["Heat (1995).mkv", "Heat (1995).hu.ac3"]).filter((track) => track.file).length,
    1,
  );
});

test("a series unknown subtitle queues every episode that still has it", () => {
  const tracks = rollupSubtitles([
    {
      path: "/tv/Show/S01E01.mkv",
      subtitleTracks: [{ language: null, placement: "internal", format: "SRT", forced: false, streamIndex: 0, detectedLanguage: "Hungarian" }],
    },
    {
      path: "/tv/Show/S01E02.mkv",
      subtitleTracks: [{ language: null, placement: "internal", format: "SRT", forced: false, streamIndex: 0 }],
    },
    {
      path: "/tv/Show/S01E03.mkv",
      subtitleTracks: [{ language: null, placement: "internal", format: "SRT", forced: false, streamIndex: 0 }],
    },
  ]);
  const unknown = tracks.find((track) => !track.language && !track.detectedLanguage);
  const known = tracks.find((track) => track.detectedLanguage === "Hungarian");
  assert.deepEqual(unknown?.copies?.map((copy) => copy.path), ["/tv/Show/S01E02.mkv", "/tv/Show/S01E03.mkv"]);
  assert.equal(known?.copies, undefined);
  const queued = subtitleTargets(null, unknown ?? tracks[0]!, 0, "Show");
  assert.deepEqual(queued.map((target) => target.path), ["/tv/Show/S01E02.mkv", "/tv/Show/S01E03.mkv"]);
});

test("a detected stereo or mono track can be heard again until it is commentary", () => {
  const stereo = { language: null, layout: "2.0", codec: "Dolby Digital", detectedLanguage: "English", streamIndex: 3 };
  assert.equal(audioTargets("/movies/Alien.mkv", stereo, 3, "Alien").length, 1);
  assert.equal(audioTargets("/movies/Alien.mkv", { ...stereo, layout: "1.0" }, 4, "Alien").length, 1);
  assert.equal(audioTargets("/movies/Alien.mkv", { ...stereo, detectedRole: "commentary" }, 3, "Alien").length, 0);
  assert.equal(audioTargets("/movies/Alien.mkv", { ...stereo, layout: "5.1" }, 0, "Alien").length, 0);
  assert.equal(audioTargets("/movies/Alien.mkv", { ...stereo, language: "English" }, 3, "Alien").length, 0);
  assert.equal(audioTargets("/movies/Adjustment.m2ts", { ...stereo, detectedLanguage: "Portuguese", detectedRole: "short", fromFile: true }, 1, "Film").length, 0);
  assert.equal(audioTargets("/movies/Adjustment.m2ts", { language: null, layout: "2.0", codec: "AC3", fromFile: true, detectedLanguage: "English" }, 9, "Film").length, 0);
  const external = {
    language: null,
    layout: null,
    codec: "Dolby Digital",
    file: "/movies/Alien/audio/Alien.ac3",
    fromFile: true,
    folderOnly: true,
  };
  assert.deepEqual(audioTargets("/movies/Alien.mkv", external, 0, "Alien").map((target) => target.path), ["/movies/Alien/audio/Alien.ac3"]);
  assert.equal(audioTargets("/movies/Alien.mkv", { ...external, language: "English" }, 0, "Alien").length, 0);
});

test("an audio sample is taken at 10 and 20 minutes and keeps the decoded packets", () => {
  assert.deepEqual(sampleOffsets(6360), [600, 1200]);
  assert.deepEqual(sampleOffsets(null), [600, 1200]);
  assert.deepEqual(sampleOffsets(15 * 60), [600, 180]);
  assert.deepEqual(sampleOffsets(20 * 60), [600, 180]);
  assert.deepEqual(sampleOffsets(21 * 60), [600, 1200]);
  assert.deepEqual(sampleOffsets(40), [20, 1]);
  assert.deepEqual(sampleOffsets(114), [57, 1]);
  assert.deepEqual(sampleOffsets(2), [1]);
  assert.equal(clipStart(600, 3_600), 4_200);
  assert.equal(clipStart(600, 0), 600);
  assert.equal(clipStart(600, null), 600);
  const args = audioClipArgs("/movies/Adjustment.m2ts", 0, 90, "/tmp/clip.wav");
  assert.ok(args.indexOf("-seek2any") < args.indexOf("-i"));
  assert.ok(args.indexOf("-t") < args.indexOf("-i"));
  assert.equal(args[args.indexOf("-map") + 1], "0:a:0");
  assert.equal(args[args.indexOf("-c:a") + 1], "pcm_s16le");
  const copied = audioCopyArgs("/movies/Adjustment.m2ts", 0, 4_200, "/tmp/clip.mka");
  assert.ok(copied.indexOf("-t") < copied.indexOf("-i"));
  assert.equal(copied[copied.indexOf("-c") + 1], "copy");
  assert.equal(copied[copied.indexOf("-ss") + 1], "4200");
  const surround = audioClipArgs("/movies/Adjustment.m2ts", 0, 90, "/tmp/clip.wav", dialogueMix("5.1", 6));
  assert.equal(surround[surround.indexOf("-af") + 1], "pan=mono|c0=0.7*FC+0.15*FL+0.15*FR");
  assert.equal(dialogueMix("stereo", 2), null);
  assert.equal(dialogueMix("5.1(side)", 6), "pan=mono|c0=0.7*FC+0.15*FL+0.15*FR");
  const size = 40_000_000_000;
  const early = tsWindow(size, 6_360, 600, 192);
  const later = tsWindow(size, 6_360, 1_200, 192);
  assert.ok(early);
  assert.ok(later);
  assert.equal(early.start % 192, 0);
  assert.ok(early.start > size * 0.08 && early.start < size * 0.11);
  assert.ok(later.start > early.start);
  assert.ok(early.end <= size);
  assert.ok(early.end - early.start < size * 0.01);
  const tail = tsWindow(10_000_000, 100, 90, 192);
  assert.ok(tail);
  assert.equal(tail.start % 192, 0);
  assert.ok(tail.end <= 10_000_000);
  const opening = openingWindow(size, 192);
  assert.ok(opening);
  assert.equal(opening.start, 0);
  assert.equal(opening.end % 192, 0);
  assert.ok(opening.end <= 8 * 1024 * 1024);
  assert.equal(languageFromProbeTags({ language: "por" }), "Portuguese");
  assert.equal(languageFromProbeTags({ language: "hun" }), "Hungarian");
  assert.equal(languageFromProbeTags({ language: "und" }), null);
  assert.equal(audioPid("0x1101"), 0x1101);
  assert.equal(isShortSpan(0.96, 6350), true);
  assert.equal(isShortSpan(6345, 6350), false);
  assert.equal(isShortSpan(0.96, 40), false);
  const oneSecond = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40), Buffer.alloc(16000 * 2)]);
  const fullClip = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40), Buffer.alloc(16000 * 2 * 20)]);
  assert.ok(Math.abs(wavSeconds(oneSecond) - 1) < 0.01);
  assert.equal(isExceptionallyShortClip(wavSeconds(oneSecond)), true);
  assert.equal(isExceptionallyShortClip(wavSeconds(fullClip)), false);
  const marker = markerWindow(23_516_110_848, 6350, 600, 192);
  assert.ok(marker);
  assert.equal(marker.start % 192, 0);
  assert.ok(marker.end - marker.start <= 2 * 1024 * 1024);
  const packet = (pid: number, pts: number | null) => {
    const bytes = Buffer.alloc(192);
    bytes[4] = 0x47;
    bytes[5] = ((pid >> 8) & 0x1f) | (pts == null ? 0 : 0x40);
    bytes[6] = pid & 0xff;
    bytes[7] = 0x10;
    if (pts == null) return bytes;
    bytes[8] = 0;
    bytes[9] = 0;
    bytes[10] = 1;
    bytes[11] = 0xbd;
    bytes[15] = 0x80;
    bytes[16] = 5;
    const ticks = Math.round(pts * 90000);
    bytes[17] = 0x21 | ((ticks >> 29) & 0x0e);
    bytes[18] = (ticks >> 22) & 0xff;
    bytes[19] = 0x01 | ((ticks >> 14) & 0xfe);
    bytes[20] = (ticks >> 7) & 0xff;
    bytes[21] = 0x01 | ((ticks << 1) & 0xfe);
    return bytes;
  };
  const stub = pidActivity(Buffer.concat([packet(0x1101, 600), packet(0x1101, 600.96), ...Array.from({ length: 40 }, () => packet(0x1100, null))]), 192, 0x1101);
  assert.equal(stub.packets, 2);
  assert.equal(stub.ended, true);
  assert.ok(stub.span != null && Math.abs(stub.span - 0.96) < 0.02);
  const ongoing = pidActivity(Buffer.concat(Array.from({ length: 40 }, () => packet(0x1100, null))), 192, 0x1100);
  assert.equal(ongoing.ended, false);
  assert.equal(audioLines([{ language: null, layout: "2.0", codec: "AC3", detectedLanguage: "Portuguese", detectedRole: "short", fromFile: true }], [])[0], "Portuguese short 2.0 AC3");
  assert.equal(pcmIsSilent(Buffer.alloc(2000)), true);
  assert.equal(pcmIsSilent(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40), Buffer.from([0, 40])])), false);
  const slice = audioSliceArgs(0, "/tmp/clip.wav", null);
  assert.equal(slice.includes("-ss"), false);
  assert.equal(slice[slice.indexOf("-i") + 1], "pipe:0");
  assert.equal(slice[slice.indexOf("-map") + 1], "0:a:0");
  assert.ok(slice.indexOf("-t") > slice.indexOf("-i"));
  assert.equal(slice[slice.indexOf("-t") + 1], "20");
  const unknown = tsWindow(40_000_000_000, null, 600, 192);
  assert.ok(unknown);
  assert.ok(unknown.end - unknown.start <= 24 * 1024 * 1024);
});

test("a sparse subtitle is sampled where its cues are", () => {
  assert.deepEqual(cueSampleStarts([74.9, 412.1, 532.1, 1418.3, 3733.3, 3770.4, 3822.4, 3869.8, 6001.3, 6195.9]), [412, 1418, 3822, 6001]);
  assert.deepEqual(cueSampleStarts([12, 40]), [12, 40]);
});

test("a pgs subtitle is copied out of the video instead of decoding the picture", () => {
  const args = pgsCopyArgs("/movies/Adjustment.m2ts", 4, 300, "/tmp/track.sup");
  assert.equal(args[args.indexOf("-map") + 1], "0:s:4");
  assert.equal(args[args.indexOf("-c") + 1], "copy");
  assert.equal(args.includes("-filter_complex"), false);
  assert.equal(args.at(-2), "sup");
  assert.ok(args.indexOf("-t") < args.indexOf("-i"));
  assert.equal(args[args.indexOf("-t") + 1], "45");
  const whole = pgsDemuxArgs("/movies/Backrooms.mkv", 0, "/tmp/track.sup");
  assert.equal(whole.includes("-ss"), false);
  assert.equal(whole[whole.indexOf("-map") + 1], "0:s:0");
  assert.equal(whole[whole.indexOf("-c") + 1], "copy");
  assert.equal(whole.at(-2), "sup");
});

test("a disc pgs window is a byte slice on stdin, not a timestamp seek", () => {
  const args = pgsSliceArgs(3, "/tmp/track.sup");
  assert.equal(args.includes("-ss"), false);
  assert.equal(args[args.indexOf("-f") + 1], "mpegts");
  assert.equal(args[args.indexOf("-i") + 1], "pipe:0");
  assert.equal(args[args.indexOf("-map") + 1], "0:s:3");
  assert.equal(args.at(-2), "sup");
  const size = 30_000_000_000;
  const audio = tsWindow(size, 6_360, 600, 192)!;
  const subtitle = tsWindow(size, 6_360, 600, 192, 30)!;
  assert.equal(subtitle.start, audio.start);
  assert.ok(subtitle.end - subtitle.start > audio.end - audio.start);
  assert.equal(subtitle.start % 192, 0);
});

test("a vobsub picture is drawn as an image and cropped to the text", () => {
  const args = vobsubExtractArgs("/movies/Aliens.mkv", 2, 600, "/tmp/cue-%02d.png");
  assert.match(args[args.indexOf("-filter_complex") + 1] ?? "", /\[0:s:2\].*\[sub\]/);
  assert.equal(args[args.indexOf("-map") + 1], "[sub]");
  assert.equal(args[args.indexOf("-c:v") + 1], "png");
  assert.equal(args.includes("-canvas_size"), false);
});

test("a binary sub file is a picture and a microdvd sub file is text", () => {
  assert.equal(subtitleSampleIsText(Buffer.from("{1}{50}Hello there\n")), true);
  assert.equal(subtitleSampleIsText(Buffer.from([0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x00, 0x01, 0xbd])), false);
  const loose = vobsubExtractArgs("/movies/Film.sub", 0, 0, "/tmp/cue-%02d.png", vobsubCanvasSize(null));
  assert.ok(loose.indexOf("-canvas_size") < loose.indexOf("-i"));
  assert.equal(loose[loose.indexOf("-canvas_size") + 1], "1920x1080");
  assert.equal(loose[loose.indexOf("-ss") + 1], "0");
  assert.equal(vobsubCanvasSize("# VobSub index file\nsize: 720x576\n"), "720x576");
});

test("pgs bitmap text is read back from the subtitle stream", () => {
  const palette = Buffer.from([
    0, 0,
    0, 16, 128, 128, 0,
    1, 235, 128, 128, 255,
  ]);
  const rows: number[] = [];
  for (let line = 0; line < 16; line += 1) {
    const ink = line >= 3 && line < 13;
    if (!ink) rows.push(0x00, 0x10, 0x00, 0x00);
    else rows.push(0x00, 0x03, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x03, 0x00, 0x00);
  }
  const rle = Buffer.from(rows);
  const object = Buffer.alloc(11 + rle.length);
  object[3] = 0xc0;
  object.writeUIntBE(4 + rle.length, 4, 3);
  object.writeUInt16BE(16, 7);
  object.writeUInt16BE(16, 9);
  rle.copy(object, 11);
  const packet = (type: number, body: Buffer) => {
    const header = Buffer.alloc(13);
    header[0] = 0x50;
    header[1] = 0x47;
    header[10] = type;
    header.writeUInt16BE(body.length, 11);
    return Buffer.concat([header, body]);
  };
  const images = readPgsImages(Buffer.concat([packet(0x14, palette), packet(0x15, object), packet(0x80, Buffer.alloc(0))]));
  assert.equal(images.length, 1);
  assert.ok((images[0]?.width ?? 0) >= 8);
  assert.ok(images[0]?.rgba.includes(255));
  const scaled = scaleBitmap(images[0]!, 3);
  assert.equal(scaled.width, (images[0]?.width ?? 0) * 3);
  assert.ok(scaled.rgba.includes(255));
});

test("pgs keeps the letters and drops the box behind them", () => {
  const packet = (type: number, body: Buffer) => {
    const header = Buffer.alloc(13);
    header[0] = 0x50;
    header[1] = 0x47;
    header[10] = type;
    header.writeUInt16BE(body.length, 11);
    return Buffer.concat([header, body]);
  };
  const frame = (palette: Buffer, text: number) => {
    const pixels: number[] = [];
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) pixels.push(y === 8 && x >= 4 && x < 12 ? text : 1);
    }
    const rle = Buffer.from(pixels);
    const object = Buffer.alloc(11 + rle.length);
    object[3] = 0xc0;
    object.writeUIntBE(4 + rle.length, 4, 3);
    object.writeUInt16BE(16, 7);
    object.writeUInt16BE(16, 9);
    rle.copy(object, 11);
    const images = readPgsImages(Buffer.concat([packet(0x14, palette), packet(0x15, object), packet(0x80, Buffer.alloc(0))]));
    const bitmap = images[0];
    let white = 0;
    if (bitmap) {
      for (let index = 0; index < bitmap.rgba.length; index += 4) if (bitmap.rgba[index] === 255) white += 1;
    }
    return white;
  };
  const brightOnGray = Buffer.from([0, 0, 1, 128, 128, 128, 255, 2, 235, 128, 128, 255]);
  const darkOnWhite = Buffer.from([0, 0, 1, 235, 128, 128, 255, 2, 16, 128, 128, 255]);
  assert.equal(frame(brightOnGray, 2), 8);
  assert.equal(frame(darkOnWhite, 2), 8);
});

test("text language detection reads english and hungarian subtitles", () => {
  const english = Array(6).fill("She closed the door and walked into the kitchen while the rain started again on the empty street.").join(" ");
  const hungarian = Array(6).fill("Becsukta az ajtót, és kiment a konyhába, miközben az eső újra eleredt az üres utcán.").join(" ");
  assert.equal(detectTextLanguage(english).language, "English");
  assert.equal(detectTextLanguage(hungarian).language, "Hungarian");
  assert.equal(detectTextLanguage("Szia, hogy vagy? Nem tudom, hol hagytam a kulcsot. Gyere be, esik az eső. Kat, ezt nem hiszem el. Patrick azt mondta, hogy holnap találkozunk. Nincs időm erre a hülyeségre.").language, "Hungarian");
  assert.equal(detectTextLanguage("Hi").language, null);
  assert.equal(detectTextLanguage("AVI LIST hdrl avih strl movi idx1 JUNK RIFF WAVE fmt data LIST INFO ISFT Lavf BPS DURATION NUMBER OF FRAMES".repeat(4)).language, null);
});

test("a central european subtitle is decoded before the language is guessed", () => {
  const stored = Buffer.from(
    "Szia, hogy vagy? Nem tudom, hol hagytam a kulcsot. Gyere be, esik az es\u00f5. \u00d5 azt hitte, hogy szerelmes bel\u00e9d. Nincs id\u00f5m erre a h\u00fclyes\u00e9gre.",
    "latin1",
  );
  const text = decodeSubtitleBytes(stored);
  assert.match(text, /eső/);
  assert.equal(stored.toString("utf8").includes("eső"), false);
  assert.equal(detectTextLanguage(text).language, "Hungarian");
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
  ]);
  const scanned = new Set(["/movies/Dune.mkv\0audio\0" + "1"]);
  const again = targetsFromFiles([file], false, scanned);
  assert.equal(again.some((target) => target.kind === "audio"), false);
  const rescan = targetsFromFiles([file], true, scanned);
  assert.equal(rescan.some((target) => target.kind === "audio"), true);
  const discAudio: ScanFile = {
    label: "Adjustment",
    path: "/movies/Adjustment.m2ts",
    container: "m2ts",
    playableLabel: "video",
    audioTracks: [
      { language: "English", layout: "5.1", codec: "DTS", streamIndex: 0 },
      { language: "Polish", layout: "2.0", codec: "AC3", streamIndex: 5 },
    ],
    subtitleTracks: [],
    versions: [],
  };
  assert.deepEqual(
    targetsFromFiles([discAudio], false, new Set()).map((target) => `${target.placement}:${target.ordinal}`),
    ["named:0", "named:5"],
  );
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
  const [named] = overlayAudio("/movies/Adjustment.m2ts", [
    { language: null, layout: "2.0", codec: "AC3", streamIndex: 1 },
  ], new Map([["/movies/Adjustment.m2ts\0audio\0" + "1", { language: "Portuguese", role: "short", source: "file" }]]));
  assert.equal(named?.detectedLanguage, "Portuguese");
  assert.equal(named?.detectedRole, "short");
  assert.equal(named?.fromFile, true);
  const [subtitle] = overlaySubtitles("/movies/Dune.mkv", [
    { language: null, placement: "external", format: "SRT", forced: false, file: "/movies/Dune.hu.srt" },
  ], new Map([[`/movies/Dune.hu.srt\0subtitle\0${0}`, { language: "Hungarian", role: null }]]));
  assert.equal(subtitle?.detectedLanguage, "Hungarian");
  assert.equal(subtitle?.forced, false);
  const [signs] = overlaySubtitles("/movies/Backrooms.mkv", [
    { language: null, placement: "internal", format: "PGS", forced: false, streamIndex: 0 },
  ], new Map([["/movies/Backrooms.mkv\0subtitle\0" + "0", { language: "French", role: "forced" }]]));
  assert.equal(signs?.detectedLanguage, "French");
  assert.equal(signs?.forced, true);
  assert.equal(subtitleNote(signs!), "PGS · forced");
});

test("a manual start pulls a waiting track out of the overnight queue", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/movies/Kwai.m2ts", kind: "subtitle", ordinal: 31, label: "Kwai", format: "PGS", placement: "internal", streamLabel: null },
  ], "window");
  const again = enqueueTargets(db, [
    { path: "/movies/Kwai.m2ts", kind: "subtitle", ordinal: 31, label: "Kwai", format: "PGS", placement: "internal", streamLabel: null },
  ], "immediate");
  assert.equal(again.added, 1);
  assert.equal(again.already, 0);
  const job = claimNextJob(db, false);
  assert.equal(job?.path, "/movies/Kwai.m2ts");
  assert.equal(job?.priority, "immediate");
  db.close();
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

test("clearing the queue drops waiting tracks and keeps a finished one visible", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/done.mkv", kind: "subtitle", ordinal: 0, label: "Done", format: "PGS", placement: "internal", streamLabel: null },
    { path: "/wait.mkv", kind: "subtitle", ordinal: 1, label: "Wait", format: "PGS", placement: "internal", streamLabel: null },
  ], "immediate");
  const job = claimNextJob(db, true);
  assert.ok(job);
  finishJob(db, job!.id, "failed", "This language cannot be reliably recognized.");
  saveDetection(db, job!, { language: null, role: null, confidence: 0, message: "This language cannot be reliably recognized." });
  const mixed = listJobs(db, { page: 1, pageSize: 50 });
  assert.equal(mixed.total, 2);
  assert.deepEqual(mixed.jobs.map((row) => row.status).sort(), ["failed", "pending"]);
  assert.equal(clearPendingJobs(db), 1);
  const listed = listJobs(db, { status: "failed", page: 1, pageSize: 50 });
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.jobs.map((row) => row.label), ["Done"]);
  assert.equal(listed.jobs[0]?.status, "failed");
  assert.equal(listJobs(db, { status: "pending", page: 1, pageSize: 50 }).total, 0);
  const stored = db.prepare(`SELECT message FROM detect_results WHERE path = '/done.mkv'`).get() as { message: string };
  assert.match(stored.message, /reliably recognized/);
  db.close();
});

test("clearing a filter removes only that status and keeps the language", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/failed.mkv", kind: "subtitle", ordinal: 0, label: "Failed", format: "PGS", placement: "internal", streamLabel: null },
    { path: "/done.mkv", kind: "subtitle", ordinal: 1, label: "Named", format: "SRT", placement: "internal", streamLabel: null },
  ], "immediate");
  const failed = claimNextJob(db, true);
  finishJob(db, failed!.id, "failed", "This language cannot be reliably recognized.");
  saveDetection(db, failed!, { language: null, role: null, confidence: 0, message: "This language cannot be reliably recognized." });
  const named = claimNextJob(db, true);
  finishJob(db, named!.id, "done", "Hungarian");
  saveDetection(db, named!, { language: "Hungarian", role: null, confidence: 1, message: null });
  assert.equal(clearJobs(db, "failed"), 1);
  assert.equal(listJobs(db, { status: "failed", page: 1, pageSize: 50 }).total, 0);
  assert.equal(listJobs(db, { status: "done", page: 1, pageSize: 50 }).total, 1);
  const stored = db.prepare(`SELECT language FROM detect_results WHERE path = '/done.mkv'`).get() as { language: string };
  assert.equal(stored.language, "Hungarian");
  db.close();
});

test("all tasks shows failed and waiting in one list", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/failed.mkv", kind: "subtitle", ordinal: 0, label: "Failed", format: "PGS", placement: "internal", streamLabel: null },
    { path: "/wait.mkv", kind: "subtitle", ordinal: 1, label: "Wait", format: "SRT", placement: "internal", streamLabel: null },
  ], "immediate");
  const job = claimNextJob(db, true);
  finishJob(db, job!.id, "failed", "This language cannot be reliably recognized.");
  const mixed = listTaskJobs(db, { queue: "all", status: "all", page: 1, pageSize: 50 });
  assert.equal(mixed.total, 2);
  assert.deepEqual(mixed.jobs.map((row) => row.status).sort(), ["failed", "pending"]);
  const failedOnly = listTaskJobs(db, { queue: "all", status: "failed", page: 1, pageSize: 50 });
  assert.equal(failedOnly.total, 1);
  db.close();
});

test("redoing a failed language check queues that same track now", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/failed.mkv", kind: "subtitle", ordinal: 0, label: "Failed", format: "PGS", placement: "internal", streamLabel: null },
  ], "window");
  const job = claimNextJob(db, true);
  finishJob(db, job!.id, "failed", "This language cannot be reliably recognized.");
  assert.equal(retryFailedJob(db, job!.id), "retried");
  const again = claimNextJob(db, false);
  assert.equal(again?.id, job!.id);
  assert.equal(again?.priority, "immediate");
  assert.equal(retryFailedJob(db, job!.id), "missing");
  db.close();
});

test("redoing a failure whose track is already queued removes the failure and runs the queued one now", () => {
  const db = new Database(":memory:");
  migrate(db);
  const target = { path: "/twice.mkv", kind: "subtitle" as const, ordinal: 0, label: "Twice", format: "PGS", placement: "internal", streamLabel: null };
  enqueueTargets(db, [target], "window");
  const job = claimNextJob(db, true);
  finishJob(db, job!.id, "failed", "No subtitle images could be read.");
  enqueueTargets(db, [target], "window");
  assert.equal(retryFailedJob(db, job!.id), "already");
  assert.equal(listJobs(db, { status: "failed", page: 1, pageSize: 50 }).total, 0);
  const waiting = listJobs(db, { status: "pending", page: 1, pageSize: 50 });
  assert.equal(waiting.total, 1);
  assert.equal(waiting.jobs[0]?.priority, "immediate");
  db.close();
});

test("redo all keeps one retry per track and drops failures that are already queued", () => {
  const db = new Database(":memory:");
  migrate(db);
  const a = { path: "/a.mkv", kind: "subtitle" as const, ordinal: 0, label: "A", format: "PGS", placement: "internal", streamLabel: null };
  const b = { path: "/b.mkv", kind: "subtitle" as const, ordinal: 0, label: "B", format: "PGS", placement: "internal", streamLabel: null };
  for (let round = 0; round < 2; round += 1) {
    enqueueTargets(db, [a], "window");
    const job = claimNextJob(db, true);
    finishJob(db, job!.id, "failed", "No subtitle images could be read.");
  }
  enqueueTargets(db, [b], "window");
  const failedB = claimNextJob(db, true);
  finishJob(db, failedB!.id, "failed", "No subtitle images could be read.");
  enqueueTargets(db, [b], "window");
  assert.equal(retryAllFailedJobs(db), 1);
  assert.equal(listJobs(db, { status: "failed", page: 1, pageSize: 50 }).total, 0);
  assert.equal(listJobs(db, { status: "pending", page: 1, pageSize: 50 }).total, 2);
  db.close();
});

test("redoing every failed language check puts them on the overnight queue", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/a.mkv", kind: "subtitle", ordinal: 0, label: "A", format: "PGS", placement: "internal", streamLabel: null },
    { path: "/b.mkv", kind: "audio", ordinal: 1, label: "B", format: "AC3", placement: "internal", streamLabel: null },
  ], "window");
  const first = claimNextJob(db, true);
  finishJob(db, first!.id, "failed", "No subtitle images could be read.");
  const second = claimNextJob(db, true);
  finishJob(db, second!.id, "failed", "The audio sample could not be read in time.");
  assert.equal(retryAllFailedJobs(db), 2);
  const waiting = listJobs(db, { status: "pending", page: 1, pageSize: 50 });
  assert.equal(waiting.total, 2);
  assert.ok(waiting.jobs.every((row) => row.priority === "window"));
  assert.equal(listJobs(db, { status: "failed", page: 1, pageSize: 50 }).total, 0);
  assert.equal(retryAllFailedJobs(db), 0);
  db.close();
});

test("an unread subtitle file is a failed check, not a finished one", () => {
  assert.equal(
    finishedStatus({
      language: null,
      message: "Plex did not name this subtitle file, so the video was not read as text. Put a matching .srt beside the video (same title) or refresh Plex.",
    }),
    "skipped",
  );
  assert.equal(finishedStatus({ language: null, message: "The subtitle file is not readable text." }), "failed");
  assert.equal(finishedStatus({ language: null, message: "This language cannot be reliably recognized." }), "failed");
  assert.equal(finishedStatus({ language: "Hungarian", message: null }), "done");
});

test("plex background work and transcodes count as busy", () => {
  assert.equal(plexActivitiesBusy({ MediaContainer: { size: 0 } }), false);
  assert.equal(plexActivitiesBusy({ MediaContainer: { size: 1, Activity: [{ type: "library.update" }] } }), true);
  assert.equal(plexTranscodeBusy({ MediaContainer: { Metadata: [{ title: "Dune" }] } }), false);
  assert.equal(plexTranscodeBusy({ MediaContainer: { Metadata: [{ TranscodeSession: { throttled: false } }] } }), true);
});

test("mkvpropedit's own reason is the failure, because it writes that to standard output", () => {
  const text = commandFailureText(
    "mkvpropedit",
    "The file is being analyzed.\nError: The file could not be opened for writing. Possible reasons are: the file is write-protected.\n",
    "",
  );
  assert.match(text, /could not be opened for writing/);
  assert.equal(commandFailureText("mkvpropedit", "The file is being analyzed.\nDone.\n", ""), "mkvpropedit could not change the file.");
});

test("a recognized language is planned as a file tag or a renamed subtitle", () => {
  assert.deepEqual(planTag("/movies/Dune.mkv", "audio", 1, "Hungarian", "commentary"), {
    action: "matroska",
    selector: "track:a2",
    language: "hun",
    commentary: true,
    forced: false,
  });
  assert.deepEqual(planTag("/movies/Dune.mkv", "subtitle", 0, "Hungarian", null), {
    action: "matroska",
    selector: "track:s1",
    language: "hun",
    commentary: false,
    forced: false,
  });
  assert.deepEqual(planTag("/movies/Backrooms.mkv", "subtitle", 0, "French", "forced"), {
    action: "matroska",
    selector: "track:s1",
    language: "fra",
    commentary: false,
    forced: true,
  });
  assert.deepEqual(planTag("/movies/Dune.mp4", "audio", 0, "English", null), {
    action: "mp4",
    specifier: "s:a:0",
    language: "eng",
    commentary: false,
    forced: false,
  });
  const renamed = planTag("/movies/Dune.srt", "subtitle", 0, "Hungarian", null);
  assert.equal(renamed.action === "rename" && renamed.to, "/movies/Dune.hun.srt");
  const signs = planTag("/movies/Backrooms.srt", "subtitle", 0, "French", "forced");
  assert.equal(signs.action === "rename" && signs.to, "/movies/Backrooms.fra.forced.srt");
  const forced = planTag("/movies/Dune.forced.srt", "subtitle", 0, "Hungarian", null);
  assert.equal(forced.action === "rename" && forced.to, "/movies/Dune.hun.forced.srt");
  const pair = planTag("/movies/Dune.idx", "subtitle", 0, "Hungarian", null);
  assert.equal(pair.action === "rename" && pair.pairTo, "/movies/Dune.hun.sub");
  assert.deepEqual(planTag("/movies/Dune.eng.srt", "subtitle", 0, "Hungarian", null), { action: "skip", reason: "already-named" });
  assert.deepEqual(planTag("/movies/Dune.avi", "audio", 0, "Hungarian", null), {
    action: "riff",
    header: "IAS1",
    language: "hun",
    commentary: false,
  });
  assert.deepEqual(planTag("/movies/Dune.avi", "audio", 1, "Italian", null), {
    action: "riff",
    header: "IAS2",
    language: "ita",
    commentary: false,
  });
  assert.deepEqual(planTag("/movies/Film.m2ts", "audio", 0, "English", null), { action: "skip", reason: "container" });
  assert.equal(retargetPath("/mnt/media/Dune.srt", "/Volumes/media/Dune.srt", "/Volumes/media/Dune.hun.srt"), "/mnt/media/Dune.hun.srt");
  const mkv = planTag("/movies/Dune.mkv", "audio", 0, "Hungarian", null);
  assert.equal(fileOmitsSavedLanguage(mkv, null), true);
  assert.equal(fileOmitsSavedLanguage(mkv, "Hungarian"), false);
  assert.equal(fileOmitsSavedLanguage(mkv, "English"), false);
  assert.equal(fileOmitsSavedLanguage(planTag("/movies/Film.m2ts", "audio", 0, "English", null), null), false);
});

test("a folder scan queues a recognized language when the file tag is empty", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/movies/10 Things.mkv", kind: "audio", ordinal: 0, label: "10 Things", format: null, placement: null, streamLabel: null },
  ], "immediate");
  const job = claimNextJob(db, true);
  assert.ok(job);
  saveDetection(db, job!, { language: "English", role: null, confidence: 1, message: null });
  markWritten(db, job!, job!.path);
  markTagChecked(db, job!);
  assert.equal(queueUnlabeledRecognition(db, recognizedWrites(db), "/Movies/10 Things.mkv", "audio", 0), true);
  const row = db.prepare(`SELECT written_at, tag_checked_at FROM detect_results WHERE path = '/movies/10 Things.mkv'`).get() as {
    written_at: string | null;
    tag_checked_at: string | null;
  };
  assert.equal(row.written_at, null);
  assert.equal(row.tag_checked_at, null);
  assert.equal(hasUnwritten(db), true);
  saveDetection(db, job!, { language: "English", role: null, confidence: 1, message: null, source: "file" });
  markWritten(db, job!, job!.path);
  assert.equal(queueUnlabeledRecognition(db, recognizedWrites(db), job!.path, "audio", 0), false);
  db.close();
});

test("a recognized language marked done is queued again when the file never received it", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueTargets(db, [
    { path: "/movies/Dune.avi", kind: "audio", ordinal: 0, label: "Dune", format: null, placement: null, streamLabel: null },
  ], "immediate");
  const job = claimNextJob(db, true);
  assert.ok(job);
  saveDetection(db, job!, { language: "Hungarian", role: null, confidence: 1, message: null });
  markWritten(db, job!, job!.path);
  assert.equal(hasUncheckedTags(db), true);
  assert.equal(hasUnwritten(db), false);
  reopenForWrite(db, job!);
  assert.equal(hasUnwritten(db), true);
  const row = db.prepare(`SELECT written_at FROM detect_results WHERE path = '/movies/Dune.avi'`).get() as { written_at: string | null };
  assert.equal(row.written_at, null);
  db.close();
});

test("a recognized language is saved on the library row that owns the file", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO catalog_titles (
      kind, title, sort_title, playable_label, path, audio_tracks, subtitle_tracks, audio_languages, subtitle_languages, versions_json
    ) VALUES ('movie', 'Dune', 'dune', 'video', '/movies/Dune.mkv', ?, ?, '[]', '[]', ?)`,
  ).run(
    JSON.stringify([{ language: null, layout: "2.0", codec: "AAC", streamIndex: 1 }]),
    JSON.stringify([{ language: null, placement: "external", format: "SRT", forced: false, file: "/movies/Dune.srt" }]),
    JSON.stringify([
      {
        path: "/movies/Dune.other.mkv",
        audioTracks: [{ language: null, layout: "2.0", codec: "AAC", streamIndex: 0 }],
        audioLanguages: [],
        subtitleTracks: [],
        subtitleLanguages: [],
      },
    ]),
  );
  const videos = stampLanguage(db, {
    path: "/movies/Dune.mkv",
    kind: "audio",
    ordinal: 1,
    language: "Hungarian",
    role: "commentary",
    renamedTo: null,
  });
  assert.deepEqual(videos, ["/movies/Dune.mkv"]);
  const row = db.prepare(`SELECT audio_tracks, audio_languages, subtitle_tracks, versions_json FROM catalog_titles`).get() as {
    audio_tracks: string;
    audio_languages: string;
    subtitle_tracks: string;
    versions_json: string;
  };
  const audio = JSON.parse(row.audio_tracks) as Array<{ language: string; label: string }>;
  assert.equal(audio[0]?.language, "Hungarian");
  assert.equal(audio[0]?.label, "Commentary");
  assert.deepEqual(JSON.parse(row.audio_languages), ["Hungarian"]);
  const other = JSON.parse(row.versions_json) as Array<{ audioTracks: Array<{ language: string | null }> }>;
  assert.equal(other[0]?.audioTracks[0]?.language, null);

  const renamed = stampLanguage(db, {
    path: "/movies/Dune.srt",
    kind: "subtitle",
    ordinal: 0,
    language: "Hungarian",
    role: null,
    renamedTo: "/movies/Dune.hun.srt",
  });
  assert.deepEqual(renamed, ["/movies/Dune.mkv"]);
  const subtitles = JSON.parse(
    (db.prepare(`SELECT subtitle_tracks FROM catalog_titles`).get() as { subtitle_tracks: string }).subtitle_tracks,
  ) as Array<{ language: string; file: string }>;
  assert.equal(subtitles[0]?.language, "Hungarian");
  assert.equal(subtitles[0]?.file, "/movies/Dune.hun.srt");
  db.close();
});

test("player ids follow the video path", () => {
  const ids = playerIdsForPaths(
    [
      { connector: "plex", externalKey: "item:42", parentKey: null, path: "/movies/Dune.mkv", filesJson: "[]" },
      { connector: "plex", externalKey: "episode:9", parentKey: null, path: "/tv/Show.mkv", filesJson: "[]" },
      { connector: "radarr", externalKey: "7", parentKey: null, path: null, filesJson: JSON.stringify([{ path: "/movies/Dune.mkv" }]) },
      { connector: "sonarr", externalKey: "3", parentKey: "sonarr-series:15", path: "/tv/Show.mkv", filesJson: "[]" },
      { connector: "bazarr", externalKey: "radarr:7", parentKey: null, path: "/movies/Dune.mkv", filesJson: "[]" },
      { connector: "bazarr", externalKey: "sonarr-episode:3", parentKey: "sonarr-series:15", path: "/tv/Show.mkv", filesJson: "[]" },
    ],
    ["/movies/Dune.mkv"],
  );
  assert.deepEqual(ids.plex, ["42"]);
  assert.deepEqual(ids.radarr, [7]);
  assert.deepEqual(ids.sonarr, []);
  assert.deepEqual(ids.bazarrMovies, [7]);
  assert.deepEqual(ids.bazarrSeries, []);
});

test("a write-protected mkv still receives the language in the same file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-mkv-"));
  const file = path.join(dir, "episode.mkv");
  const run = (command: string, args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(command, args, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.toString() || error.message));
        else resolve(stdout.toString().trim());
      });
    });
  try {
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=160x120:d=1",
      "-c:v",
      "mpeg4",
      "-c:a",
      "ac3",
      "-shortest",
      file,
    ]);
    fs.chmodSync(file, 0o444);
    const db = new Database(path.join(dir, "library.db"));
    migrate(db);
    const written = await writeFinding(
      db,
      { path: file, kind: "audio", ordinal: 0, placement: null, streamLabel: null },
      file,
      "Hungarian",
      null,
    );
    db.close();
    assert.equal(written.changed, true);
    assert.equal(written.sentence, "Written into the file.");
    assert.equal(fs.existsSync(file), true);
    const language = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream_tags=language", "-of", "default=nw=1:nk=1", file]);
    assert.equal(language, "hun");
  } finally {
    try {
      fs.chmodSync(file, 0o644);
    } catch {
      // The sample was never created.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
