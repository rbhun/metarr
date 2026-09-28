import assert from "node:assert/strict";
import test from "node:test";
import { assignStreamLanguages, crossCheckAudio, crossCheckSubtitles, detect3d, detectHdr, fillOmittedAudio, knownLanguage, languageCode, multiPartLabel, normalizeContainer, normalizeTitle, noteFilePresence, playableFrom, presenceTooltip, reconcileAudio, resolvedResolution, sourceTooltip, summarizeFiles, tagFileOrigin, versionsFrom } from "@/lib/media";
import type { MediaFile } from "@/lib/types";

test("disc images and video files get distinct playable labels", () => {
  assert.equal(playableFrom(false, null, null), "missing");
  assert.equal(playableFrom(true, "mkv", "/movies/Film.mkv"), "video");
  assert.equal(playableFrom(true, "mp4", "/movies/Film.mp4"), "video");
  assert.equal(playableFrom(true, "iso", "/movies/Film.iso"), "iso");
  assert.equal(playableFrom(true, "img", "/movies/Film.img"), "iso");
  assert.equal(playableFrom(true, "iso", "/movies/Film.DVDR.iso"), "dvd-iso");
  assert.equal(playableFrom(true, "iso", "/movies/Film.BD50.iso"), "bluray-iso");
  assert.equal(playableFrom(true, "iso", "/movies/Film.1080p.BluRay.iso"), "bluray-iso");
  assert.equal(playableFrom(true, "m2ts", "/movies/Avatar/BDMV/STREAM/00000.m2ts"), "bluray");
  assert.equal(playableFrom(true, "mpegts", "/movies/Jaws/00294.m2ts"), "video");
  assert.equal(normalizeContainer("mpegts", "/movies/Jaws/00294.m2ts"), "m2ts");
  assert.equal(playableFrom(true, "mpegts", "/movies/Film.ts"), "video");
  assert.equal(playableFrom(true, "vob", "/movies/DVD/VIDEO_TS/VTS_01_1.VOB"), "dvd");
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
  assert.equal(summary.playableNote, "Also has an ISO");
});

test("a 1080p SDR file stays listed beside a 2160p HDR file", () => {
  const versions = versionsFrom([
    {
      container: "mkv",
      path: "/movies/Interstellar (2014)/Interstellar.2014.2160p.UHD.BluRay.DoVi.mkv",
      qualityName: null,
      resolution: "2160p",
      hdr: "Dolby Vision",
      is3d: false,
      audioLanguages: ["Hungarian", "English"],
      subtitleLanguages: ["English"],
      bitrateKbps: 43000,
    },
    {
      container: "mkv",
      path: "/movies/Interstellar (2014)/interstellar.imax.1080p.mkv",
      qualityName: null,
      resolution: "1080p",
      hdr: "none",
      is3d: false,
      audioLanguages: [],
      subtitleLanguages: [],
      audioTracks: [{ language: null, layout: "5.1", codec: "DTS" }],
    },
  ]);
  assert.equal(versions.length, 2);
  assert.equal(versions[0]?.resolution, "2160p");
  assert.equal(versions[0]?.hdr, "Dolby Vision");
  assert.equal(versions[1]?.resolution, "1080p");
  assert.equal(versions[1]?.hdr, "none");
  assert.equal(versions[1]?.edition, "IMAX");
  assert.deepEqual(versions[1]?.missing, ["subtitles"]);
  assert.deepEqual(versions[0]?.missing, []);
  assert.equal(resolvedResolution({ resolution: null, height: 336, path: "/movies/Fantasia.avi" }), "336p");
});

test("a split movie is marked as a part, and a sequel title is not", () => {
  assert.equal(multiPartLabel("/movies/Lawrence/Lawrence (1962) - 1 of 2.mkv"), "1 of 2");
  assert.equal(multiPartLabel("/movies/Lawrence/Lawrence (1962) - 02 of 02.mkv"), "2 of 2");
  assert.equal(multiPartLabel("Movie.1of2.avi"), "1 of 2");
  assert.equal(multiPartLabel("Movie (1/2).mkv"), "1 of 2");
  assert.equal(multiPartLabel("/movies/Foo/Foo CD1.avi"), "Part 1");
  assert.equal(multiPartLabel("/movies/Foo/Foo - pt2.mkv"), "Part 2");
  assert.equal(multiPartLabel("/movies/Ben-Hur/Ben Hur - Part1.m2ts"), "Part 1");
  assert.equal(multiPartLabel("/movies/Foo/Foo - part 1.mkv"), null);
  assert.equal(multiPartLabel("/movies/The Godfather Part II.mkv"), null);
  assert.equal(multiPartLabel("Harry Potter and the Deathly Hallows Part 2 (2011).mkv"), null);
  assert.equal(multiPartLabel("History of the World - Part 1.avi"), null);
  assert.equal(multiPartLabel("/movies/Airplane II/Airplane.2.mkv"), null);
  assert.equal(multiPartLabel(null), null);
});

test("a sample name and a tiny extra file are marked, a feature is not", () => {
  const feature: MediaFile = {
    container: "mkv",
    path: "/movies/Airplane II/Airplane.2.mkv",
    qualityName: null,
    resolution: "1080p",
    hdr: "none",
    is3d: false,
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
    fileBytes: 5_500_000_000,
  };
  const versions = versionsFrom([
    feature,
    { ...feature, path: "/movies/Airplane II/Sample.mkv", fileBytes: 354_000_000, subtitleLanguages: [] },
    { ...feature, path: "/movies/Blood Diamond/ETRG.mp4", fileBytes: 1_400_000, subtitleLanguages: [] },
  ]);
  assert.deepEqual(versions.find((version) => version.name === "Airplane.2.mkv")?.flags, []);
  assert.deepEqual(versions.find((version) => version.name === "Sample.mkv")?.flags, ["sample", "short"]);
  assert.ok(versions.find((version) => version.name === "ETRG.mp4")?.flags.includes("sample"));
  assert.ok(versions.find((version) => version.name === "ETRG.mp4")?.flags.includes("short"));
});

test("a blank audio track takes the language Radarr already listed when the order lines up", () => {
  const tracks = ["English", null, null, "Magyar", null, "Polski", null, null, null, "English"];
  const radarr = ["English", "Portuguese", "Czech", "Hungarian", "Spanish", "Polish", "Russian", "Thai", "Turkish"];
  assert.deepEqual(assignStreamLanguages(tracks, radarr), [
    "English",
    "Portuguese",
    "Czech",
    "Hungarian",
    "Spanish",
    "Polish",
    "Russian",
    "Thai",
    "Turkish",
    "English",
  ]);
  const filled = fillOmittedAudio(
    tracks.map((language, streamIndex) => ({ language, layout: "2.0", codec: "AC3", streamIndex })),
    radarr,
  );
  assert.equal(filled[1]?.language, "Portuguese");
  assert.equal(filled[1]?.omittedByPlex, true);
  assert.equal(filled[0]?.omittedByPlex, undefined);
  assert.equal(filled[3]?.language, "Magyar");
  assert.equal(assignStreamLanguages([null, "English"], ["English"]), null);
});

test("a language label names which source has it", () => {
  const plex = tagFileOrigin(
    {
      container: "m2ts",
      path: "/movies/Film.m2ts",
      qualityName: null,
      resolution: "1080p",
      hdr: "none",
      is3d: false,
      audioLanguages: ["English"],
      subtitleLanguages: ["English"],
      audioTracks: [{ language: "English", layout: "5.1", codec: "DTS", streamIndex: 0 }, { language: null, layout: "2.0", codec: "AC3", streamIndex: 1 }],
      subtitleTracks: [{ language: "English", placement: "internal", format: "PGS", forced: false, streamIndex: 0 }],
    },
    "plex",
  );
  const radarr = tagFileOrigin(
    {
      container: "m2ts",
      path: "/movies/Film.m2ts",
      qualityName: null,
      resolution: "1080p",
      hdr: "none",
      is3d: false,
      audioLanguages: ["English", "Portuguese"],
      subtitleLanguages: ["English", "Portuguese"],
    },
    "radarr",
  );
  const scanned = tagFileOrigin(
    {
      container: "m2ts",
      path: "/movies/Film.m2ts",
      qualityName: null,
      resolution: null,
      hdr: "none",
      is3d: false,
      audioLanguages: ["English", "Portuguese"],
      subtitleLanguages: ["English"],
      audioTracks: [
        { language: "English", layout: null, codec: null, streamIndex: 0, fromFile: true },
        { language: "Portuguese", layout: null, codec: null, streamIndex: 1, fromFile: true },
      ],
      subtitleTracks: [{ language: "English", placement: "internal", format: "PGS", forced: false, streamIndex: 0, fromFile: true }],
    },
    "files",
  );
  const withRadarr = reconcileAudio(plex, radarr);
  const checked = reconcileAudio(
    { ...plex, audioTracks: withRadarr },
    scanned,
  );
  assert.equal(sourceTooltip(checked[0]?.sources, "English"), "Plex: present\nRadarr: present\nFile scan: present");
  assert.equal(sourceTooltip(checked[1]?.sources, "Portuguese"), "Plex: missing\nRadarr: present\nFile scan: present");
  assert.equal(sourceTooltip({ plex: "Hungarian" }, "Czech"), "Plex: Hungarian\nFile scan: not scanned");
});

test("a folder scan keeps the file language and marks a Plex mismatch", () => {
  const plex = [
    { language: "English", layout: "5.1", codec: "DTS-HD", streamIndex: 0 },
    { language: null, layout: "2.0", codec: "Dolby Digital", streamIndex: 1 },
    { language: "Hungarian", layout: "5.1", codec: "DTS", streamIndex: 2 },
  ];
  const scanned = [
    { language: "English", layout: null, codec: null, streamIndex: 0, fromFile: true },
    { language: "Portuguese", layout: null, codec: null, streamIndex: 1, fromFile: true },
    { language: "Czech", layout: null, codec: null, streamIndex: 2, fromFile: true },
  ];
  const checked = crossCheckAudio(plex, scanned);
  assert.equal(checked[0]?.conflict, undefined);
  assert.equal(checked[1]?.language, "Portuguese");
  assert.equal(checked[1]?.conflict, "Plex left this language out.");
  assert.equal(checked[2]?.conflict, "Plex says Hungarian.");
  const merged = reconcileAudio(
    { container: "m2ts", path: "/movies/Film.m2ts", qualityName: null, resolution: "1080p", hdr: "none", is3d: false, audioLanguages: ["English", "Hungarian"], subtitleLanguages: [], audioTracks: plex, subtitleTracks: [] },
    { container: "m2ts", path: "/movies/Film.m2ts", qualityName: null, resolution: null, hdr: "none", is3d: false, audioLanguages: ["English", "Portuguese", "Czech"], subtitleLanguages: ["English"], audioTracks: scanned, subtitleTracks: [{ language: "Portuguese", placement: "internal", format: "PGS", forced: false, streamIndex: 0, fromFile: true }] },
  );
  assert.equal(merged[1]?.fromFile, true);
  const subs = crossCheckSubtitles(
    [{ language: null, placement: "internal", format: "PGS", forced: false, streamIndex: 0 }],
    [{ language: "Portuguese", placement: "internal", format: "PGS", forced: false, streamIndex: 0, fromFile: true }],
  );
  assert.equal(subs[0]?.language, "Portuguese");
  assert.equal(subs[0]?.conflict, "Plex left this language out.");
});

test("a language name maps to the tag stored in a media file", () => {
  assert.equal(knownLanguage("Português"), "Portuguese");
  assert.equal(knownLanguage("Čeština"), "Czech");
  assert.equal(knownLanguage("Español"), "Spanish");
  assert.equal(knownLanguage("Русский"), "Russian");
  assert.equal(knownLanguage("ไทย"), "Thai");
  assert.equal(knownLanguage("Türkçe"), "Turkish");
  assert.equal(knownLanguage("română"), "Romanian");
  assert.equal(knownLanguage("slovenščina"), "Slovenian");
  assert.equal(languageCode("Hungarian"), "hun");
  assert.equal(languageCode("hu"), "hun");
  assert.equal(languageCode("English"), "eng");
  assert.equal(languageCode("und"), null);
});

test("a file pill lists which source has that file", () => {
  const plex = tagFileOrigin(
    { container: "mkv", path: "/movies/Film.mkv", qualityName: null, resolution: "1080p", hdr: "none", is3d: false, audioLanguages: [], subtitleLanguages: [] },
    "plex",
  );
  const noted = noteFilePresence([plex], ["plex", "radarr"]);
  assert.equal(noted[0]?.presence?.plex, true);
  assert.equal(noted[0]?.presence?.radarr, null);
  assert.equal(presenceTooltip(noted[0]?.presence), "Plex: present\nRadarr: missing\nFile scan: not scanned");
  const versions = versionsFrom(noted);
  assert.equal(versions[0]?.presence?.plex, true);
});
