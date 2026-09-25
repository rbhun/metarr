import assert from "node:assert/strict";
import test from "node:test";
import { detect3d, detectHdr, normalizeTitle, playableFrom, summarizeFiles } from "@/lib/media";

test("disc images and video files get distinct playable labels", () => {
  assert.equal(playableFrom(false, null, null), "missing");
  assert.equal(playableFrom(true, "mkv", "/movies/Film.mkv"), "video");
  assert.equal(playableFrom(true, "mp4", "/movies/Film.mp4"), "video");
  assert.equal(playableFrom(true, "iso", "/movies/Film.iso"), "disc");
  assert.equal(playableFrom(true, "img", "/movies/Film.img"), "disc");
  assert.equal(playableFrom(true, "m2ts", "/movies/Avatar/BDMV/STREAM/00000.m2ts"), "disc");
  assert.equal(playableFrom(true, "vob", "/movies/DVD/VIDEO_TS/VTS_01_1.VOB"), "disc");
});

test("hdr detection prefers Dolby Vision and HDR10+", () => {
  assert.equal(detectHdr(["Dolby Vision", "HDR10"]), "Dolby Vision");
  assert.equal(detectHdr(["DV"]), "Dolby Vision");
  assert.equal(detectHdr(["HDR10+"]), "HDR10+");
  assert.equal(detectHdr(["HDR10"]), "HDR10");
  assert.equal(detectHdr(["HLG"]), "HLG");
  assert.equal(detectHdr(["HDR"]), "HDR10");
  assert.equal(detectHdr(["smpte2084"]), "HDR10");
  assert.equal(detectHdr([""]), "none");
});

test("3d markers come from the title or path", () => {
  assert.equal(detect3d(["Avatar"]), false);
  assert.equal(detect3d(["Gravity HSBS"]), true);
  assert.equal(detect3d(["Dune 3D"]), true);
  assert.equal(detect3d(["/movies/Film.HOU.mkv"]), true);
});

test("title normalization joins part ii and part 2", () => {
  assert.equal(normalizeTitle("The Godfather: Part II"), normalizeTitle("Godfather Part 2"));
});

test("a video file plus a disc image stays playable and notes the disc", () => {
  const summary = summarizeFiles([
    {
      container: "mkv",
      path: "/movies/Film.mkv",
      qualityName: "Bluray-1080p",
      resolution: "1080p",
      hdr: "none",
      is3d: false,
      audioLanguages: ["English"],
      subtitleLanguages: ["English"],
    },
    {
      container: "iso",
      path: "/movies/Film.iso",
      qualityName: null,
      resolution: "1080p",
      hdr: "none",
      is3d: false,
      audioLanguages: [],
      subtitleLanguages: [],
    },
  ]);
  assert.equal(summary.playableLabel, "video");
  assert.equal(summary.playableNote, "Also has a disc image");
  assert.match(summary.container ?? "", /mkv/);
  assert.match(summary.container ?? "", /iso/);
});
