import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "@/lib/db";
import { avisFromFile } from "@/lib/rewrap/candidates";
import { checkRewrap, parseProbe, progressFromLine, rewrapArgs, rewrapAvi, type Probe } from "@/lib/rewrap/run";
import { isAvi, rewrappedPathFor, rewrapTarget } from "@/lib/rewrap/source";
import {
  claimNextRewrap,
  enqueueRewraps,
  finishRewrap,
  finishedRewrapPaths,
  hasImmediateRewrap,
  parseFirstLanguage,
  readRewrapSettings,
  retryFailedRewrap,
  rewrapTotals,
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
  assert.deepEqual(first, { id: 2, path: "/m/Film.avi", label: "Film (1999)", languages: ["hun"] });
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
  assert.deepEqual(avis, [{ path: "/m/Film.avi", label: "Film (1999)", languages: ["hun", "English"] }]);
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
