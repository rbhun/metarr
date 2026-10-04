import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { rebuildCatalog } from "@/lib/catalog";
import { migrate, insertSourceRecords } from "@/lib/db";
import { demoRecords } from "@/lib/demo";
import {
  bothHaveKnownAudio,
  candidateFromVersions,
  donorAudioLanguages,
  evaluatePair,
  inspectTitleMerge,
  languagesOnlyIn,
  listMergeCandidates,
  pairCandidates,
  resolveTitleIdForMerge,
  type MergeVersionView,
} from "@/lib/merge/candidates";
import {
  DEFAULT_MAX_DURATION_DELTA_MINUTES,
  durationsCloseMinutes,
  durationsCloseSeconds,
  framesMatch,
  meanAbsoluteDiff,
  sampleOffsets,
} from "@/lib/merge/compare";
import { pickVideoSource, qualityScore } from "@/lib/merge/quality";
import { checkMerge, mergeArgs, parseMergeProbe, progressFromLine, type Probe } from "@/lib/merge/run";
import { canMergeVersion, mergeTarget } from "@/lib/merge/source";
import {
  claimNextMerge,
  enqueueMerges,
  finishMerge,
  mergeTotals,
  parseMaxDurationDeltaMinutes,
  readMergeSettings,
  removeMergeJob,
  retryFailedMerge,
  writeMergeSettings,
} from "@/lib/merge/store";
import type { ScanFile } from "@/lib/detect/targets";

const VIDEO: Probe = {
  duration: 7200,
  streams: [
    { index: 0, codecType: "video", codecName: "hevc", language: null },
    { index: 1, codecType: "audio", codecName: "truehd", language: "eng" },
    { index: 2, codecType: "subtitle", codecName: "hdmv_pgs_subtitle", language: "eng" },
  ],
};

const OTHER: Probe = {
  duration: 7201,
  streams: [
    { index: 0, codecType: "video", codecName: "h264", language: null },
    { index: 1, codecType: "audio", codecName: "ac3", language: "hun" },
    { index: 2, codecType: "audio", codecName: "pcm_bluray", language: "eng" },
    { index: 3, codecType: "subtitle", codecName: "subrip", language: "hun" },
  ],
};

function version(partial: Partial<MergeVersionView> & Pick<MergeVersionView, "path" | "name">): MergeVersionView {
  return {
    resolution: "1080p",
    bitrateKbps: 8000,
    fileBytes: 8_000_000_000,
    hdr: "none",
    edition: null,
    durationMinutes: 120,
    audioLanguages: ["English"],
    subtitleLanguages: [],
    flags: [],
    playableLabel: "video",
    container: "mkv",
    ...partial,
  };
}

test("merge keeps the video source name and writes beside it", () => {
  assert.equal(mergeTarget("/movies/Film (1999)/Film.mkv"), "/movies/Film (1999)/Film.combined.mkv");
  assert.equal(canMergeVersion("video", "mkv", "/m/Film.mkv"), true);
  assert.equal(canMergeVersion("bluray", "iso", "/m/Film.iso"), false);
});

test("higher resolution or bitrate becomes the video source", () => {
  assert.equal(
    pickVideoSource(
      { resolution: "1080p", bitrateKbps: 20_000, fileBytes: 20_000_000_000, hdr: "none" },
      { resolution: "2160p", bitrateKbps: 8_000, fileBytes: 10_000_000_000, hdr: "none" },
    ),
    "right",
  );
  assert.equal(
    pickVideoSource(
      { resolution: "1080p", bitrateKbps: 20_000, fileBytes: 1, hdr: "none" },
      { resolution: "1080p", bitrateKbps: 8_000, fileBytes: 99_000_000_000, hdr: "Dolby Vision" },
    ),
    "left",
  );
  assert.ok(qualityScore({ resolution: "2160p", bitrateKbps: 1, fileBytes: 1, hdr: "none" }) > qualityScore({ resolution: "1080p", bitrateKbps: 50_000, fileBytes: 50_000_000_000, hdr: "Dolby Vision" }));
});

test("duration closeness rejects extended cuts and allows restored copies", () => {
  assert.equal(durationsCloseMinutes(120, 120).ok, true);
  assert.equal(durationsCloseMinutes(120, 121).ok, true);
  assert.equal(durationsCloseMinutes(120, 145).ok, false);
  assert.equal(durationsCloseSeconds(7200, 7210).ok, true);
  assert.equal(durationsCloseSeconds(7200, 9000).ok, false);
  assert.equal(durationsCloseMinutes(120, 123, 1).ok, false);
  assert.equal(durationsCloseMinutes(120, 123, 3).ok, true);
  assert.equal(durationsCloseMinutes(120, 145, 30).ok, true);
  assert.equal(DEFAULT_MAX_DURATION_DELTA_MINUTES, 1);
  assert.equal(parseMaxDurationDeltaMinutes("2.5"), 2.5);
  assert.equal(parseMaxDurationDeltaMinutes(-1), null);
  assert.equal(parseMaxDurationDeltaMinutes(121), null);
});

test("frame samples and grayscale diffs", () => {
  assert.deepEqual(sampleOffsets(100, 5).map((value) => Math.round(value)), [5, 28, 50, 73, 95]);
  const left = Buffer.from([10, 20, 30, 40]);
  const right = Buffer.from([10, 22, 28, 40]);
  assert.equal(meanAbsoluteDiff(left, right), 1);
  assert.equal(framesMatch([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 40, 40]), true);
  assert.equal(framesMatch([5, 5, 5, 40, 40, 40, 40, 40, 40, 40, 40, 40]), false);
});

test("complementary audio languages make a pair", () => {
  assert.deepEqual(languagesOnlyIn(["English", "Hungarian"], ["English"]), ["Hungarian"]);
  const left = version({ path: "/m/Film-UHD.mkv", name: "Film-UHD.mkv", resolution: "2160p", audioLanguages: ["English"] });
  const right = version({ path: "/m/Film-Hun.mkv", name: "Film-Hun.mkv", resolution: "1080p", audioLanguages: ["Hungarian", "English"], bitrateKbps: 4000 });
  const pair = candidateFromVersions("Film (1999)", 1, left, right);
  assert.ok(pair);
  assert.equal(pair!.videoFrom, "left");
  assert.deepEqual(pair!.audioOnlyRight, ["Hungarian"]);
  assert.equal(pair!.editionConflict, false);
  assert.match(pair!.reason, /Adds Hungarian from Film-Hun\.mkv/);

  const extended = candidateFromVersions("Film (1999)", 1, left, version({ ...right, durationMinutes: 145, edition: "Extended" }));
  assert.equal(extended, null);

  const labeled = candidateFromVersions(
    "Film (1999)",
    1,
    version({ ...left, edition: "Theatrical" }),
    version({ ...right, edition: "Remastered" }),
  );
  assert.ok(labeled?.editionConflict);
});

test("a file with no known audio language is not a merge candidate", () => {
  const named = version({
    path: "/m/Film-A.mkv",
    name: "Film-A.mkv",
    resolution: "352p",
    bitrateKbps: 1100,
    durationMinutes: 22,
    audioLanguages: ["English"],
  });
  const unknown = version({
    path: "/m/Film-B.mkv",
    name: "Film-B.mkv",
    resolution: "352p",
    bitrateKbps: 1100,
    durationMinutes: 21,
    audioLanguages: [],
  });
  assert.equal(bothHaveKnownAudio(named, unknown), false);
  assert.equal(candidateFromVersions("Film (1999)", 1, named, unknown), null);
  assert.equal(candidateFromVersions("Film (1999)", 1, unknown, named), null);
  assert.equal(
    pairCandidates({
      titleId: 1,
      label: "Film (1999)",
      path: named.path,
      container: "mkv",
      playableLabel: "video",
      audioTracks: [],
      subtitleTracks: [],
      versions: [
        {
          name: named.name,
          path: named.path,
          container: "mkv",
          resolution: "352p",
          hdr: "none",
          is3d: false,
          qualityName: null,
          bitrateKbps: 1100,
          playableLabel: "video",
          edition: null,
          audioLanguages: ["English"],
          subtitleLanguages: [],
          audioTracks: [],
          subtitleTracks: [],
          missing: [],
          flags: [],
          fileBytes: 200_000_000,
          durationMinutes: 22,
        },
        {
          name: unknown.name,
          path: unknown.path,
          container: "mkv",
          resolution: "352p",
          hdr: "none",
          is3d: false,
          qualityName: null,
          bitrateKbps: 1100,
          playableLabel: "video",
          edition: null,
          audioLanguages: [],
          subtitleLanguages: [],
          audioTracks: [],
          subtitleTracks: [],
          missing: [],
          flags: [],
          fileBytes: 200_000_000,
          durationMinutes: 21,
        },
      ],
    }).length,
    0,
  );
});

test("a worse file that adds no new audio is not a merge candidate", () => {
  const uhd = version({
    path: "/m/Film-UHD.mkv",
    name: "Film-UHD.mkv",
    resolution: "2160p",
    bitrateKbps: 45_000,
    audioLanguages: ["Russian", "English"],
  });
  const sd = version({
    path: "/m/Film-SD.mkv",
    name: "Film-SD.mkv",
    resolution: "480p",
    bitrateKbps: 1700,
    audioLanguages: ["English"],
  });
  assert.deepEqual(donorAudioLanguages(uhd, sd, "left"), []);
  assert.equal(candidateFromVersions("Film (1999)", 1, uhd, sd), null);
  assert.equal(
    pairCandidates({
      titleId: 1,
      label: "Film (1999)",
      path: uhd.path,
      container: "mkv",
      playableLabel: "video",
      audioTracks: [],
      subtitleTracks: [],
      versions: [
        {
          name: uhd.name,
          path: uhd.path,
          container: "mkv",
          resolution: "2160p",
          hdr: "none",
          is3d: false,
          qualityName: null,
          bitrateKbps: 45_000,
          playableLabel: "video",
          edition: null,
          audioLanguages: ["Russian", "English"],
          subtitleLanguages: [],
          audioTracks: [],
          subtitleTracks: [],
          missing: [],
          flags: [],
          fileBytes: 20_000_000_000,
          durationMinutes: 62,
        },
        {
          name: sd.name,
          path: sd.path,
          container: "mkv",
          resolution: "480p",
          hdr: "none",
          is3d: false,
          qualityName: null,
          bitrateKbps: 1700,
          playableLabel: "video",
          edition: null,
          audioLanguages: ["English"],
          subtitleLanguages: [],
          audioTracks: [],
          subtitleTracks: [],
          missing: [],
          flags: [],
          fileBytes: 700_000_000,
          durationMinutes: 62,
        },
      ],
    }).length,
    0,
  );
});

test("pairCandidates walks every version pair on a title", () => {
  const file: ScanFile = {
    titleId: 9,
    label: "Film (1999)",
    path: "/m/Film-UHD.mkv",
    container: "mkv",
    playableLabel: "video",
    audioTracks: [],
    subtitleTracks: [],
    versions: [
      {
        name: "Film-UHD.mkv",
        path: "/m/Film-UHD.mkv",
        container: "mkv",
        resolution: "2160p",
        hdr: "none",
        is3d: false,
        qualityName: null,
        bitrateKbps: 40_000,
        playableLabel: "video",
        edition: null,
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
        audioTracks: [],
        subtitleTracks: [],
        missing: [],
        flags: [],
        fileBytes: 40_000_000_000,
        durationMinutes: 120,
      },
      {
        name: "Film-Hun.mkv",
        path: "/m/Film-Hun.mkv",
        container: "mkv",
        resolution: "1080p",
        hdr: "none",
        is3d: false,
        qualityName: null,
        bitrateKbps: 8_000,
        playableLabel: "video",
        edition: null,
        audioLanguages: ["Hungarian"],
        subtitleLanguages: ["Hungarian"],
        audioTracks: [],
        subtitleTracks: [],
        missing: [],
        flags: [],
        fileBytes: 8_000_000_000,
        durationMinutes: 120,
      },
      {
        name: "Film-sample.mkv",
        path: "/m/Film-sample.mkv",
        container: "mkv",
        resolution: "480p",
        hdr: "none",
        is3d: false,
        qualityName: null,
        bitrateKbps: 1000,
        playableLabel: "video",
        edition: null,
        audioLanguages: ["French"],
        subtitleLanguages: [],
        audioTracks: [],
        subtitleTracks: [],
        missing: [],
        flags: ["sample"],
        fileBytes: 20_000_000,
        durationMinutes: 2,
      },
    ],
  };
  const pairs = pairCandidates(file);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.videoFrom, "left");
  assert.deepEqual(pairs[0]!.audioOnlyRight, ["Hungarian"]);
});

test("ffmpeg merge maps video from input 0 and audio or subtitles from both", () => {
  const plan = mergeArgs("/v.mkv", "/a.mkv", "/out.mkv", VIDEO, OTHER);
  const args = plan.args.join(" ");
  assert.match(args, /-i \/v\.mkv -i \/a\.mkv/);
  assert.match(args, /-map 0:0 -map 0:1 -map 1:1 -map 1:2 -map 0:2 -map 1:3/);
  assert.match(args, /-c:a:2 flac/);
  assert.match(args, /-metadata:s:a:1 language=hun/);
  assert.deepEqual([plan.video, plan.audio, plan.subtitles, plan.converted], [1, 3, 2, 1]);
  assert.equal(progressFromLine("out_time_us=3600000000", 7200), 50);
  assert.equal(checkMerge(VIDEO, { ...VIDEO, streams: [...VIDEO.streams, ...OTHER.streams.filter((stream) => stream.codecType !== "video")] }, plan), null);
  assert.match(checkMerge(VIDEO, VIDEO, plan) ?? "", /missing a stream/);
});

test("probe JSON keeps stream languages", () => {
  const probe = parseMergeProbe(
    JSON.stringify({
      streams: [{ index: 0, codec_type: "video", codec_name: "hevc" }, { index: 1, codec_type: "audio", codec_name: "ac3", tags: { language: "hun" } }],
      format: { duration: "100.5" },
    }),
  );
  assert.equal(probe.duration, 100.5);
  assert.equal(probe.streams[1]!.language, "hun");
});

test("the demo library exposes a merge candidate with complementary audio", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, demoRecords());
  rebuildCatalog(db);
  const candidates = listMergeCandidates(db, "Blade");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.label.includes("Blade Runner 2049"), true);
  assert.equal(candidates[0]!.videoFrom, "left");
  assert.ok(candidates[0]!.audioOnlyRight.includes("Hungarian") || candidates[0]!.audioOnlyLeft.includes("Hungarian"));
  db.close();
});

test("merge queue is manual and can be turned off", () => {
  const db = new Database(":memory:");
  migrate(db);
  assert.deepEqual(readMergeSettings(db), { enabled: true, maxDurationDeltaMinutes: 1 });
  writeMergeSettings(db, { enabled: false });
  assert.equal(readMergeSettings(db).enabled, false);
  writeMergeSettings(db, { enabled: true, maxDurationDeltaMinutes: 2.5 });
  assert.deepEqual(readMergeSettings(db), { enabled: true, maxDurationDeltaMinutes: 2.5 });

  assert.deepEqual(
    enqueueMerges(db, [
      { leftPath: "/m/a.mkv", rightPath: "/m/b.mkv", videoPath: "/m/a.mkv", label: "Film" },
      { leftPath: "/m/b.mkv", rightPath: "/m/a.mkv", videoPath: "/m/a.mkv" },
    ]),
    { added: 1, already: 1 },
  );
  const job = claimNextMerge(db);
  assert.ok(job);
  assert.equal(job!.videoPath, "/m/a.mkv");
  finishMerge(db, job!.id, "failed", "nope");
  assert.equal(retryFailedMerge(db, job!.id), "retried");
  assert.deepEqual(mergeTotals(db), { pending: 1, running: 0, done: 0, failed: 0 });
});

test("evaluatePair explains duration and audio rejections", () => {
  const file: ScanFile = {
    titleId: 1,
    label: "Film (1999)",
    path: "/m/Film-A.mkv",
    container: "mkv",
    playableLabel: "video",
    audioTracks: [],
    subtitleTracks: [],
    versions: [],
  };
  const left = version({ path: "/m/Film-A.mkv", name: "Film-A.mkv", resolution: "2160p", audioLanguages: ["English"] });
  const far = version({
    path: "/m/Film-B.mkv",
    name: "Film-B.mkv",
    resolution: "1080p",
    audioLanguages: ["Hungarian"],
    durationMinutes: 125,
  });
  const rejected = evaluatePair(file, left, far, { maxDurationDeltaMinutes: 1 });
  assert.equal(rejected.eligible, false);
  assert.match(rejected.reason, /Runtimes differ by 5 min \(allowed 1 min\)/);
  assert.equal(rejected.candidate, null);

  const allowed = evaluatePair(file, left, far, { maxDurationDeltaMinutes: 5 });
  assert.equal(allowed.eligible, true);
  assert.ok(allowed.candidate);
  assert.match(allowed.reason, /±5 min/);
});

test("manual title check lists eligible and rejected pairs", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, demoRecords());
  rebuildCatalog(db);
  const found = resolveTitleIdForMerge(db, "Blade Runner");
  assert.ok(found);
  assert.match(found!.label, /Blade Runner 2049/);
  const byId = resolveTitleIdForMerge(db, String(found!.titleId));
  assert.equal(byId?.titleId, found!.titleId);

  const inspect = inspectTitleMerge(db, found!.titleId, { maxDurationDeltaMinutes: 1 });
  assert.ok(inspect);
  assert.ok(inspect!.versions.length >= 2);
  assert.ok(inspect!.pairs.length >= 1);
  assert.ok(inspect!.eligibleCount >= 1);
  assert.ok(inspect!.pairs.some((pair) => pair.eligible));
  db.close();
});

test("removing one waiting or failed merge leaves the others", () => {
  const db = new Database(":memory:");
  migrate(db);
  enqueueMerges(db, [
    { leftPath: "/m/a.mkv", rightPath: "/m/b.mkv", videoPath: "/m/a.mkv", label: "First" },
    { leftPath: "/m/c.mkv", rightPath: "/m/d.mkv", videoPath: "/m/c.mkv", label: "Second" },
  ]);
  const first = claimNextMerge(db);
  assert.ok(first);
  finishMerge(db, first.id, "failed", "No.");
  const waiting = db.prepare(`SELECT id FROM merge_jobs WHERE status = 'pending'`).get() as { id: number };
  assert.equal(removeMergeJob(db, waiting.id), true);
  assert.equal(mergeTotals(db).pending, 0);
  assert.equal(removeMergeJob(db, first.id), true);
  assert.equal(mergeTotals(db).failed, 0);
  assert.equal(removeMergeJob(db, first.id), false);
  db.close();
});
