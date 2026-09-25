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
import { rollupSubtitles } from "@/lib/detect/rollup";
import { subtitleTargets } from "@/lib/detect/track";
import { decodeSubtitleBytes } from "@/lib/detect/encoding";
import { readPgsImages, scaleBitmap } from "@/lib/detect/pgs";
import { audioClipArgs, dialogueMix, sampleOffsets } from "@/lib/detect/audio";
import { pgsCopyArgs, vobsubExtractArgs } from "@/lib/detect/picture";
import { detectTextLanguage } from "@/lib/detect/text-language";
import { shownLanguage } from "@/lib/format";
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

test("an audio sample is taken from the first minutes and keeps the decoded packets", () => {
  assert.deepEqual(sampleOffsets(6360), [90, 300, 600]);
  assert.deepEqual(sampleOffsets(200), [90, 170]);
  const args = audioClipArgs("/movies/Adjustment.m2ts", 0, 90, "/tmp/clip.wav");
  assert.ok(args.indexOf("-t") < args.indexOf("-i"));
  assert.equal(args[args.indexOf("-map") + 1], "0:a:0");
  assert.equal(args[args.indexOf("-c:a") + 1], "pcm_s16le");
  const surround = audioClipArgs("/movies/Adjustment.m2ts", 0, 90, "/tmp/clip.wav", dialogueMix("5.1", 6));
  assert.equal(surround[surround.indexOf("-af") + 1], "pan=mono|c0=0.7*FC+0.15*FL+0.15*FR");
  assert.equal(dialogueMix("stereo", 2), null);
  assert.equal(dialogueMix("5.1(side)", 6), "pan=mono|c0=0.7*FC+0.15*FL+0.15*FR");
});

test("a pgs subtitle is copied out of the video instead of decoding the picture", () => {
  const args = pgsCopyArgs("/movies/Adjustment.m2ts", 4, 300, "/tmp/track.sup");
  assert.equal(args[args.indexOf("-map") + 1], "0:s:4");
  assert.equal(args[args.indexOf("-c") + 1], "copy");
  assert.equal(args.includes("-filter_complex"), false);
  assert.equal(args.at(-2), "sup");
  assert.equal(args[args.indexOf("-t") + 1], "180");
});

test("a vobsub picture is drawn as an image and cropped to the text", () => {
  const args = vobsubExtractArgs("/movies/Aliens.mkv", 2, 600, "/tmp/cue-%02d.png");
  assert.match(args[args.indexOf("-filter_complex") + 1] ?? "", /\[0:s:2\].*\[sub\]/);
  assert.equal(args[args.indexOf("-map") + 1], "[sub]");
  assert.equal(args[args.indexOf("-c:v") + 1], "png");
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
