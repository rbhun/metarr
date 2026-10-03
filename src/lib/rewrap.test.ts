import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "@/lib/db";
import { avisFromFile, bundleRewraps } from "@/lib/rewrap/candidates";
import { checkRewrap, parseProbe, progressFromLine, rewrapArgs, rewrapAvi, rewrapStop, type Probe } from "@/lib/rewrap/run";
import { canRewrap, isAvi, joinedTarget, rewrappedPathFor, rewrapTarget, sourceKind, splitSources } from "@/lib/rewrap/source";
import {
  claimNextRewrap,
  parseLanguages,
  enqueueRewraps,
  finishRewrap,
  finishedRewrapPaths,
  hasImmediateRewrap,
  parseFirstLanguage,
  readRewrapSettings,
  retryFailedRewrap,
  rewrapTotals,
  settleSplitRewraps,
  writeRewrapSettings,
} from "@/lib/rewrap/store";

const XVID: Probe = {
  duration: 5400,
  streams: [
    { index: 0, codecType: "video", codecName: "mpeg4" },
    { index: 1, codecType: "audio", codecName: "mp3" },
    { index: 2, codecType: "audio", codecName: "ac3" },
    { index: 3, codecType: "subtitle", codecName: "xsub" },
  ],
};

test("an AVI becomes an MKV with the same name beside it", () => {
  assert.equal(rewrapTarget("/movies/Film (1999)/Film (1999).avi"), "/movies/Film (1999)/Film (1999).mkv");
  assert.equal(rewrapTarget("/movies/Film (1999)/Film cd1.AVI"), "/movies/Film (1999)/Film cd1.mkv");
  assert.equal(isAvi(null, "/a/b.AVI"), true);
  assert.equal(isAvi("avi", "/a/b.mkv"), false);
  assert.equal(isAvi("avi", null), true);
  assert.equal(rewrappedPathFor("/m/Film.avi", ["/m/Film.avi", "/m/Film.MKV"]), "/m/Film.MKV");
  assert.equal(rewrappedPathFor("/m/Film.avi", ["/m/Film.avi", "/m/Other.mkv"]), null);
});

test("the rewrap copies every stream, unpacks Xvid B-frames, and puts the chosen language first", () => {
  const plan = rewrapArgs("in.avi", "out.mkv", XVID, { languages: ["English", "hun"], firstLanguage: "Hungarian" });
  const args = plan.args.join(" ");
  assert.match(args, /-map 0:0 -map 0:2 -map 0:1 -c copy/);
  assert.match(args, /-bsf:v:0 mpeg4_unpack_bframes/);
  assert.match(args, /-metadata:s:a:0 language=hun/);
  assert.match(args, /-metadata:s:a:1 language=eng/);
  assert.match(args, /-disposition:a:0 default -metadata:s:a:1 language=eng -disposition:a:1 0/);
  assert.doesNotMatch(args, /0:3/, "Matroska cannot hold DivX xsub, so it is left out");
  assert.equal(plan.firstMoved, true);
  assert.deepEqual([plan.video, plan.audio, plan.subtitles], [1, 2, 0]);
  assert.ok(plan.args.at(-1) === "out.mkv" && plan.args.includes("matroska"));

  const kept = rewrapArgs("in.avi", "out.mkv", XVID, { languages: [], firstLanguage: "" });
  assert.match(kept.args.join(" "), /-map 0:0 -map 0:1 -map 0:2 /);
  assert.equal(kept.firstMoved, false);

  const h264 = rewrapArgs("in.avi", "out.mkv", { duration: 10, streams: [{ index: 0, codecType: "video", codecName: "h264" }] }, { languages: [], firstLanguage: "Hungarian" });
  assert.doesNotMatch(h264.args.join(" "), /bsf/);
  assert.throws(() => rewrapArgs("in.avi", "out.mkv", { duration: 1, streams: [] }, { languages: [], firstLanguage: "" }), /no video/);
});

test("a killed ffmpeg says it ran out of memory instead of an empty exit code", () => {
  assert.match(rewrapStop("ffmpeg", null, "SIGKILL"), /ran out of memory/);
  assert.match(rewrapStop("ffmpeg", null, "SIGTERM"), /SIGTERM/);
  assert.equal(rewrapStop("ffmpeg", 1, null), "ffmpeg exited with code 1.");
});

test("probe output, progress lines, and the result check", () => {
  const probe = parseProbe(
    JSON.stringify({ streams: [{ index: 0, codec_type: "video", codec_name: "mpeg4" }, { index: 1, codec_type: "audio" }], format: { duration: "120.5" } }),
  );
  assert.equal(probe.duration, 120.5);
  assert.equal(probe.streams[1].codecName, null);
  assert.equal(progressFromLine("out_time_us=60250000", 120.5), 50);
  assert.equal(progressFromLine("out_time_us=999000000", 120.5), 99);
  assert.equal(progressFromLine("frame=10", 120.5), null);
  const expected = { video: 1, audio: 2, subtitles: 0 };
  assert.equal(checkRewrap(XVID, { ...XVID, duration: 5401 }, expected), null);
  assert.match(checkRewrap(XVID, { duration: 5400, streams: XVID.streams.slice(0, 2) }, expected) ?? "", /missing a stream/);
  assert.match(checkRewrap(XVID, { ...XVID, duration: 2000 }, expected) ?? "", /runs 2000 s/);
});

test("the rewrap queue has its own hours, and Rewrap now jumps ahead", () => {
  const db = new Database(":memory:");
  migrate(db);
  assert.deepEqual(readRewrapSettings(db), { enabled: true, startHour: 1, endHour: 7, firstLanguage: "Hungarian" });
  writeRewrapSettings(db, { startHour: 22, endHour: 4, firstLanguage: "" });
  assert.deepEqual(readRewrapSettings(db), { enabled: true, startHour: 22, endHour: 4, firstLanguage: "" });
  assert.equal(parseFirstLanguage("Klingonish"), null);
  assert.equal(parseFirstLanguage(" hun "), "hun");
  assert.equal(parseFirstLanguage(""), "");

  assert.deepEqual(enqueueRewraps(db, [{ path: "/m/Old.avi" }, { path: "/m/Film.avi", label: "Film (1999)", languages: ["hun"] }]), {
    added: 2,
    already: 0,
    promoted: 0,
  });
  assert.equal(claimNextRewrap(db, true), null);
  assert.deepEqual(enqueueRewraps(db, [{ path: "/m/Film.avi" }], true), { added: 0, already: 0, promoted: 1 });
  assert.equal(enqueueRewraps(db, [{ path: "/m/Film.avi" }], true).already, 1);
  assert.equal(hasImmediateRewrap(db), true);
  const first = claimNextRewrap(db, true);
  assert.deepEqual(first, { id: 2, path: "/m/Film.avi", label: "Film (1999)", languages: ["hun"], subtitleLanguages: [] });
  finishRewrap(db, first!.id, "done", "Saved Film.mkv.");
  const old = claimNextRewrap(db);
  assert.equal(old?.label, "Old.avi");
  finishRewrap(db, old!.id, "failed", "");
  assert.deepEqual(rewrapTotals(db), { pending: 0, running: 0, done: 1, failed: 1 });
  assert.deepEqual([...finishedRewrapPaths(db)], ["/m/Film.avi"]);
  assert.equal(retryFailedRewrap(db, old!.id), "retried");
  assert.equal(rewrapTotals(db).pending, 1);
  db.close();
});

test("library AVIs carry their title name and known audio languages", () => {
  const avis = avisFromFile({
    label: "Film (1999)",
    path: "/m/Film.mkv",
    container: "mkv",
    playableLabel: "video",
    audioTracks: [],
    subtitleTracks: [],
    versions: [
      {
        name: "AVI",
        path: "/m/Film.avi",
        container: "avi",
        playableLabel: "video",
        audioTracks: [
          { language: null, layout: null, codec: "mp3", detectedLanguage: "hun" },
          { language: "English", layout: null, codec: "ac3" },
        ],
      },
    ] as never,
  });
  assert.deepEqual(avis, [{ path: "/m/Film.avi", label: "Film (1999)", languages: ["hun", "English"], subtitleLanguages: [] }]);
});

test("a loose M2TS is rewrapped with its audio and subtitle languages, but a Blu-ray stream file is not", () => {
  assert.equal(canRewrap(null, "/m/Kwai (1957)/00336.m2ts"), true);
  assert.equal(canRewrap(null, "/m/Show/episode.ts"), true);
  assert.equal(canRewrap(null, "/m/Kwai (1957)/BDMV/STREAM/00336.m2ts"), false);
  assert.equal(canRewrap(null, "/m/Film.mkv"), false);
  assert.equal(sourceKind("/m/00336.m2ts"), "M2TS");
  assert.equal(sourceKind("/m/Film.divx"), "AVI");

  const [item] = avisFromFile({
    label: "The Bridge on the River Kwai (1957)",
    path: "/m/Kwai (1957)/00336.m2ts",
    container: "m2ts",
    playableLabel: "video",
    audioTracks: [{ language: "English", layout: null, codec: "pcm_bluray" }],
    subtitleTracks: [
      { language: null, placement: "internal", format: "PGS", forced: false, streamIndex: 0, detectedLanguage: "Spanish" },
      { language: "French", placement: "internal", format: "PGS", forced: false, streamIndex: 1 },
      { language: "Hungarian", placement: "external", format: "SRT", forced: false, file: "/m/Kwai (1957)/00336.hu.srt" },
    ],
    versions: [],
  });
  assert.deepEqual(item?.subtitleLanguages, ["Spanish", "French"]);

  const plan = rewrapArgs(
    "in.m2ts",
    "out.mkv",
    {
      duration: 9000,
      streams: [
        { index: 0, codecType: "video", codecName: "h264" },
        { index: 1, codecType: "audio", codecName: "pcm_bluray" },
        { index: 2, codecType: "subtitle", codecName: "hdmv_pgs_subtitle" },
        { index: 3, codecType: "subtitle", codecName: "hdmv_pgs_subtitle" },
      ],
    },
    { languages: item!.languages!, subtitleLanguages: item!.subtitleLanguages, firstLanguage: "" },
  );
  const args = plan.args.join(" ");
  assert.match(args, /-map 0:0 -map 0:1 -map 0:2 -map 0:3 -c copy/);
  assert.match(args, /-max_interleave_delta 10000000/, "a zero cap holds a sparse subtitle's movie in memory until ffmpeg is killed");
  assert.match(args, /-c:a:0 flac/);
  assert.match(args, /-metadata:s:s:0 language=spa/);
  assert.match(args, /-metadata:s:s:1 language=fre|-metadata:s:s:1 language=fra/);
  assert.deepEqual([plan.subtitles, plan.converted], [2, 1]);
});

test("a queued job keeps subtitle languages, and older jobs with only audio still load", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueRewraps(db, [{ path: "/m/00336.m2ts", languages: ["English"], subtitleLanguages: ["Spanish", null] }]);
  db.prepare(`INSERT INTO rewrap_jobs (path, label, languages, immediate, status, created_at) VALUES ('/m/Old.avi', 'Old', '["hun"]', 0, 'pending', '2026-01-01')`).run();
  assert.deepEqual(claimNextRewrap(db)?.subtitleLanguages, ["Spanish", null]);
  const old = claimNextRewrap(db);
  assert.deepEqual([old?.languages, old?.subtitleLanguages], [["hun"], []]);
  assert.deepEqual(parseLanguages("not json"), { audio: [], subtitles: [] });
  db.close();
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("a real Xvid AVI rewraps into an MKV beside it and the AVI stays", { skip: !hasFfmpeg }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-rewrap-"));
  try {
    const movie = path.join(root, "Film (1999)");
    fs.mkdirSync(movie);
    const avi = path.join(movie, "Film (1999).avi");
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=4",
      "-map", "0", "-map", "1", "-map", "2",
      "-c:v", "mpeg4", "-vtag", "XVID", "-bf", "2", "-c:a:0", "libmp3lame", "-c:a:1", "ac3",
      avi,
    ]);
    const before = fs.statSync(avi).size;
    const steps: number[] = [];
    const message = await rewrapAvi({
      source: avi,
      workDir: path.join(root, "work", "job-1"),
      languages: ["English", "Hungarian"],
      firstLanguage: "Hungarian",
      onProgress: (percent) => steps.push(percent),
    });
    const mkv = path.join(movie, "Film (1999).mkv");
    assert.match(message, /Saved Film \(1999\)\.mkv with 1 video stream, 2 audio tracks\. Hungarian audio goes first\./);
    assert.equal(fs.statSync(avi).size, before);
    assert.ok(fs.existsSync(mkv));
    assert.equal(fs.existsSync(`${mkv}.partial`), false);
    assert.equal(fs.existsSync(path.join(root, "work", "job-1")), false);
    const streams = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name:stream_tags=language:stream_disposition=default", "-of", "json", mkv]).toString(),
    ).streams as Array<{ codec_name: string; tags?: { language?: string }; disposition?: { default?: number } }>;
    assert.deepEqual(
      streams.map((stream) => [stream.codec_name, stream.tags?.language ?? null]),
      [
        ["mpeg4", null],
        ["ac3", "hun"],
        ["mp3", "eng"],
      ],
    );
    assert.equal(streams[1].disposition?.default, 1);
    assert.equal(streams[2].disposition?.default, 0);
    assert.equal(steps.at(-1), 100);
    await assert.rejects(
      rewrapAvi({ source: avi, workDir: path.join(root, "work", "job-2"), languages: [], firstLanguage: "", onProgress: () => undefined }),
      /already exists/,
    );
    const dry = await rewrapAvi({ source: avi, workDir: path.join(root, "work", "job-3"), languages: [], firstLanguage: "", dryRun: true, onProgress: () => undefined });
    assert.match(dry, /^Dry run: would copy 1 video stream, 2 audio tracks into .*Film \(1999\)\.mkv/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a labeled split joins into one MKV, and a missing part stays a single file", () => {
  assert.equal(joinedTarget("/movies/Foo/Foo CD1.avi"), "/movies/Foo/Foo.mkv");
  assert.equal(joinedTarget("/movies/Lawrence/Lawrence (1962) - 1 of 2.avi"), "/movies/Lawrence/Lawrence (1962).mkv");
  assert.equal(joinedTarget("/movies/Film.avi"), null);
  const read = (directory: string) => (directory === "/movies/Foo" ? ["Foo CD1.avi", "Foo CD2.avi", "notes.txt"] : null);
  assert.deepEqual(splitSources("/movies/Foo/Foo CD2.avi", read), ["/movies/Foo/Foo CD1.avi", "/movies/Foo/Foo CD2.avi"]);
  assert.deepEqual(
    splitSources("/movies/Foo/CD1/movie.avi", (directory) => {
      if (directory === "/movies/Foo/CD1" || directory === "/movies/Foo/CD2") return ["movie.avi"];
      if (directory === "/movies/Foo") return ["CD1", "CD2"];
      return null;
    }),
    ["/movies/Foo/CD1/movie.avi", "/movies/Foo/CD2/movie.avi"],
  );
  assert.equal(splitSources("/movies/Foo/Foo CD1.avi", () => ["Foo CD1.avi"]), null);
  assert.equal(splitSources("/movies/Foo/Foo CD1.avi", () => ["Foo CD1.avi", "Foo CD3.avi"]), null);
  assert.deepEqual(
    splitSources("/movies/Bar/Bar - 2 of 3.avi", (directory) =>
      directory === "/movies/Bar" ? ["Bar - 1 of 3.avi", "Bar - 2 of 3.avi", "Bar - 3 of 3.avi"] : null,
    ),
    ["/movies/Bar/Bar - 1 of 3.avi", "/movies/Bar/Bar - 2 of 3.avi", "/movies/Bar/Bar - 3 of 3.avi"],
  );
  assert.equal(joinedTarget("/movies/Bar/Bar - 3 of 3.avi"), "/movies/Bar/Bar.mkv");
  const plan = rewrapArgs("parts.txt", "Foo.mkv", XVID, { languages: ["English"], firstLanguage: "", concat: true });
  assert.match(plan.args.join(" "), /-f concat -safe 0 -i parts.txt/);
  const bundled = bundleRewraps([
    { path: "/movies/Foo/Foo CD2.avi", label: "Foo", languages: ["hun"] },
    { path: "/movies/Foo/Foo CD1.avi", label: "Foo", languages: ["eng"] },
    { path: "/movies/Other.avi", label: "Other" },
  ])
    .map((group) => group.map((item) => item.path))
    .sort((left, right) => left[0]!.localeCompare(right[0]!));
  assert.deepEqual(bundled, [
    ["/movies/Foo/Foo CD1.avi", "/movies/Foo/Foo CD2.avi"],
    ["/movies/Other.avi"],
  ]);
});

test("joining a split marks the other queued part done", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueRewraps(db, [{ path: "/m/Foo CD1.avi" }, { path: "/m/Foo CD2.avi" }]);
  const first = claimNextRewrap(db);
  settleSplitRewraps(db, ["/m/Foo CD1.avi", "/m/Foo CD2.avi"], "Saved Foo.mkv.", first!.id);
  finishRewrap(db, first!.id, "done", "Saved Foo.mkv.");
  assert.deepEqual(rewrapTotals(db), { pending: 0, running: 0, done: 2, failed: 0 });
  assert.deepEqual([...finishedRewrapPaths(db)].sort(), ["/m/Foo CD1.avi", "/m/Foo CD2.avi"]);
  db.close();
});

test("two real AVI parts join into one MKV and both parts stay", { skip: !hasFfmpeg }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-rewrap-split-"));
  try {
    const movie = path.join(root, "Foo");
    fs.mkdirSync(movie);
    const write = (name: string, tone: string) => {
      const file = path.join(movie, name);
      execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2",
        "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=2`,
        "-map", "0", "-map", "1",
        "-c:v", "mpeg4", "-vtag", "XVID", "-c:a", "libmp3lame",
        file,
      ]);
      return file;
    };
    const cd1 = write("Foo CD1.avi", "440");
    const cd2 = write("Foo CD2.avi", "660");
    const message = await rewrapAvi({
      source: cd1,
      sources: [cd1, cd2],
      workDir: path.join(root, "work"),
      languages: ["English"],
      firstLanguage: "",
      onProgress: () => undefined,
    });
    const mkv = path.join(movie, "Foo.mkv");
    assert.match(message, /Saved Foo\.mkv with 1 video stream, 1 audio track\. Joined from 2 parts\./);
    assert.ok(fs.existsSync(cd1) && fs.existsSync(cd2) && fs.existsSync(mkv));
    assert.equal(fs.existsSync(path.join(movie, "Foo CD1.mkv")), false);
    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name:stream_tags=language", "-of", "json", mkv]).toString(),
    ) as { format: { duration: string }; streams: Array<{ codec_name: string; tags?: { language?: string } }> };
    assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.5);
    assert.equal(probe.streams[1]?.tags?.language, "eng");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a real M2TS with Blu-ray PCM rewraps into an MKV with languages", { skip: !hasFfmpeg }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-rewrap-ts-"));
  try {
    const source = path.join(root, "00336.m2ts");
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=4:sample_rate=48000",
      "-map", "0", "-map", "1", "-map", "2",
      "-c:v", "mpeg2video", "-c:a:0", "pcm_bluray", "-c:a:1", "ac3", "-mpegts_m2ts_mode", "1",
      source,
    ]);
    const message = await rewrapAvi({
      source,
      workDir: path.join(root, "work", "job-1"),
      languages: ["English", "Spanish"],
      firstLanguage: "",
      onProgress: () => undefined,
    });
    assert.match(message, /Saved 00336\.mkv with 1 video stream, 2 audio tracks\. 1 PCM audio track is stored as lossless FLAC\. The M2TS was left in place\./);
    const streams = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name:stream_tags=language", "-of", "json", path.join(root, "00336.mkv")]).toString(),
    ).streams as Array<{ codec_name: string; tags?: { language?: string } }>;
    assert.deepEqual(
      streams.map((stream) => [stream.codec_name, stream.tags?.language ?? null]),
      [
        ["mpeg2video", null],
        ["flac", "eng"],
        ["ac3", "spa"],
      ],
    );
    assert.ok(fs.existsSync(source));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
