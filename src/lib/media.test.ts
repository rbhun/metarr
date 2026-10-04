import assert from "node:assert/strict";
import test from "node:test";
import { fileHoverSources, languageHover } from "@/lib/format";
import { assignStreamLanguages, bonusFlag, copyGroupId, crossCheckAudio, crossCheckSubtitles, detect3d, detectHdr, editionLabel, ensureListedSource, featureCopyCount, fillOmittedAudio, knownLanguage, languageCode, multiPartLabel, normalizeContainer, normalizeTitle, noteFilePresence, playableFrom, presenceTooltip, reconcileAudio, resolvedResolution, sourceTooltip, spacedSplitIdentity, splitIdentity, summarizeFiles, tagFileOrigin, versionsFrom } from "@/lib/media";
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

test("special release markers in the file name become edition labels", () => {
  assert.equal(editionLabel("/movies/Film-extended.mkv"), "Extended");
  assert.equal(editionLabel("/movies/Film-theatrical.mkv"), "Theatrical");
  assert.equal(editionLabel("/movies/Film-restored.mkv"), "Restored");
  assert.equal(editionLabel("/movies/Film-directors.mkv"), "Director's Cut");
  assert.equal(editionLabel("/movies/Film-directors-cut.mkv"), "Director's Cut");
  assert.equal(editionLabel("/movies/Film-anniversary.mkv"), "Anniversary");
  assert.equal(editionLabel("/movies/Film.Extended.Cut.1080p.mkv"), "Extended");
  assert.equal(editionLabel("/movies/Film.mkv"), null);
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
  assert.equal(splitIdentity("/movies/Foo/Foo - part 1.mkv"), null);
  assert.equal(spacedSplitIdentity("/movies/Foo/Foo - part 1.mkv")?.index, 1);
  assert.equal(spacedSplitIdentity("/movies/Foo/Foo - part 2.mkv")?.key, spacedSplitIdentity("/movies/Foo/Foo - part 1.mkv")?.key);
  assert.equal(spacedSplitIdentity("/movies/Foo/Foo - part 1.mkv")?.stem, "Foo");
  assert.equal(splitIdentity("History of the World - Part 1.avi"), null);
  assert.equal(spacedSplitIdentity("Harry Potter and the Deathly Hallows Part 2 (2011).mkv")?.index, 2);
  assert.equal(multiPartLabel("/movies/The Godfather Part II.mkv"), null);
  assert.equal(multiPartLabel("Harry Potter and the Deathly Hallows Part 2 (2011).mkv"), null);
  assert.equal(multiPartLabel("History of the World - Part 1.avi"), null);
  assert.equal(multiPartLabel("/movies/Airplane II/Airplane.2.mkv"), null);
  assert.equal(multiPartLabel(null), null);
  assert.equal(multiPartLabel("/tv/TaleSpin/Season 1/TaleSpin - S01E07 - Time Waits for No Bear.avi"), null);
  assert.equal(multiPartLabel("/tv/TaleSpin/Season 1/07/TaleSpin - S01E07 - Time Waits for No Bear.avi"), null);
  assert.equal(multiPartLabel("/tv/TaleSpin/Season 1/07 - Time Waits for No Bear.avi"), null);
  assert.equal(multiPartLabel("/tv/TaleSpin/Season 1/07.avi"), null);
  assert.equal(multiPartLabel("/tv/TaleSpin/1/07/S01E07.avi"), null);
  assert.equal(multiPartLabel("/tv/TaleSpin/Season 2/2/S01E14 Stormy Weather.avi"), null);
  assert.equal(multiPartLabel("/tv/TaleSpin/Season 1/13/The Idol Rich.avi"), null);
  assert.equal(multiPartLabel("/movies/Foo/Movie (1/2).mkv"), "1 of 2");
  assert.equal(
    multiPartLabel("/mnt/media/TV/Two and a Half Men/Extras/Two and a Half Men Extra 02 - Jake's A Regular Kid.mp4"),
    null,
  );
  assert.equal(splitIdentity("/mnt/media/TV/Two and a Half Men/Extras/Two and a Half Men Extra 02 - Jake's A Regular Kid.mp4"), null);

  const cd1 = "/movies/Foo/Foo CD1.avi";
  const cd2 = "/movies/Foo/Foo CD2.avi";
  const joined = "/movies/Foo/Foo.mkv";
  const other = "/movies/Foo/Foo 1080p.mkv";
  assert.equal(splitIdentity(cd1)?.stem, "Foo");
  assert.equal(splitIdentity(cd1)?.index, 1);
  assert.equal(splitIdentity(cd2)?.key, splitIdentity(cd1)?.key);
  assert.equal(splitIdentity("/movies/Lawrence/Lawrence (1962) - 1 of 2.mkv")?.stem, "Lawrence (1962)");
  assert.equal(splitIdentity("/movies/Lawrence/Lawrence (1962) - 02 of 02.mkv")?.index, 2);
  assert.equal(splitIdentity("/movies/Foo/CD1/movie.avi")?.directory, "/movies/Foo");
  assert.equal(splitIdentity("/movies/Foo/CD2/movie.avi")?.key, splitIdentity("/movies/Foo/CD1/movie.avi")?.key);
  assert.equal(splitIdentity("/movies/The Godfather Part II.mkv"), null);
  assert.equal(copyGroupId(cd1, [cd1, cd2, joined, other]), copyGroupId(cd2, [cd1, cd2, joined, other]));
  assert.equal(copyGroupId(joined, [cd1, cd2, joined, other]), copyGroupId(cd1, [cd1, cd2, joined, other]));
  assert.notEqual(copyGroupId(other, [cd1, cd2, joined, other]), copyGroupId(cd1, [cd1, cd2, joined, other]));
  assert.equal(new Set([cd1, cd2, joined].map((file) => copyGroupId(file, [cd1, cd2, joined]))).size, 1);
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

test("a feature plus a short or extra is one copy, two features are duplicates", () => {
  const feature: MediaFile = {
    container: "mkv",
    path: "/movies/Film/Film.mkv",
    qualityName: null,
    resolution: "1080p",
    hdr: "none",
    is3d: false,
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
    fileBytes: 8_000_000_000,
    durationMinutes: 120,
  };
  const withBonus = versionsFrom([
    feature,
    { ...feature, path: "/movies/Film/Intro.mkv", fileBytes: 80_000_000, durationMinutes: 5 },
    { ...feature, path: "/movies/Film/Extras/Interview.mkv", resolution: "480p", fileBytes: 400_000_000, durationMinutes: 8 },
  ]);
  assert.ok(withBonus.find((version) => version.name === "Intro.mkv")?.flags.includes("short"));
  assert.ok(withBonus.find((version) => version.name === "Interview.mkv")?.flags.includes("extra"));
  assert.equal(featureCopyCount(withBonus), 1);
  const twoCopies = versionsFrom([
    feature,
    { ...feature, path: "/movies/Film/Film.720p.mkv", resolution: "720p", fileBytes: 2_000_000_000, durationMinutes: 120 },
  ]);
  assert.equal(featureCopyCount(twoCopies), 2);
});

test("extras, featurettes, outtakes, and comic relief are labeled from the path", () => {
  assert.equal(bonusFlag("/movies/Film/Featurettes/Making Of.mkv"), "extra");
  assert.equal(bonusFlag("/movies/Film/Extras/Interview.mkv"), "extra");
  assert.equal(bonusFlag("/movies/Film/Features/Bonus Clip.mkv"), "extra");
  assert.equal(bonusFlag("/movies/Film/Special Features/Gallery.mkv"), "extra");
  assert.equal(bonusFlag("/mnt/media/TV/Top Gear/720p/Features/Apocalypse [2010].mkv"), "extra");
  assert.equal(bonusFlag("/mnt/media/TV/Two and a Half Men/Extras/Two and a Half Men Extra 02 - Jake's A Regular Kid.mp4"), "extra");
  assert.equal(bonusFlag("/movies/Film/Outtakes/Bloopers.mkv"), "outtake");
  assert.equal(bonusFlag("/movies/Film/Film-comic-relief.mkv"), "comic-relief");
  assert.equal(bonusFlag("/movies/Film/Trailers/Teaser.mkv"), "trailer");
  assert.equal(bonusFlag("/movies/Film/Film.mkv"), null);
  assert.equal(bonusFlag("/movies/Film/Film.Feature.mkv"), null);
  const feature: MediaFile = {
    container: "mkv",
    path: "/movies/Film/Film.mkv",
    qualityName: null,
    resolution: "1080p",
    hdr: "none",
    is3d: false,
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
    fileBytes: 8_000_000_000,
  };
  const versions = versionsFrom([
    feature,
    { ...feature, path: "/movies/Film/Featurettes/Looking Back.mkv", resolution: "480p", fileBytes: 400_000_000 },
    { ...feature, path: "/movies/Film/Outtakes/Gag Reel.mkv", resolution: "480p", fileBytes: 200_000_000 },
  ]);
  assert.equal(versions[0]?.name, "Film.mkv");
  assert.deepEqual(versions[0]?.flags, []);
  assert.ok(versions.find((version) => version.name === "Looking Back.mkv")?.flags.includes("extra"));
  assert.ok(versions.find((version) => version.name === "Gag Reel.mkv")?.flags.includes("outtake"));
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
  assert.equal(
    languageHover({ plex: null }, "English", null, "English"),
    "Metarr: recognized\nPlex: missing\nFile scan: not scanned",
  );
  const listed = ensureListedSource([{ language: null, sources: { plex: null } }], "radarr");
  assert.equal(sourceTooltip(listed[0]?.sources, null), "Plex: missing\nRadarr: missing\nFile scan: not scanned");
  const kept = ensureListedSource([{ language: "English", sources: { plex: "English", radarr: "English" } }], "radarr");
  assert.equal(sourceTooltip(kept[0]?.sources, "English"), "Plex: present\nRadarr: present\nFile scan: not scanned");
});

test("a movie Radarr has with no audio language says Radarr is missing", () => {
  const file = {
    container: "avi",
    path: "/movies/The Beach.avi",
    qualityName: null,
    resolution: null,
    hdr: "none" as const,
    is3d: false,
    audioLanguages: [] as string[],
    subtitleLanguages: [] as string[],
  };
  const plex = tagFileOrigin(
    { ...file, audioTracks: [{ language: null, layout: "5.1", codec: "Dolby Digital", streamIndex: 0 }], subtitleTracks: [] },
    "plex",
  );
  const radarr = tagFileOrigin(file, "radarr");
  const bazarr = tagFileOrigin(file, "bazarr");
  const named = reconcileAudio(plex, radarr);
  assert.equal(sourceTooltip(named[0]?.sources, null), "Plex: missing\nRadarr: missing\nFile scan: not scanned");
  const fromBazarr = reconcileAudio(plex, bazarr);
  assert.equal(fromBazarr[0]?.sources?.bazarr, undefined);
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
  const filled = crossCheckAudio(
    [{ language: null, layout: null, codec: null, streamIndex: 0 }],
    [{ language: null, layout: "2.0", codec: "Dolby Digital", streamIndex: 0, fromFile: true }],
  );
  assert.equal(filled[0]?.layout, "2.0");
  assert.equal(filled[0]?.codec, "Dolby Digital");
  assert.equal(filled[0]?.conflict, undefined);
  const disagreed = crossCheckAudio(
    [{ language: "English", layout: "2.0", codec: "AAC", streamIndex: 0 }],
    [{ language: "English", layout: "5.1", codec: "Dolby Digital", streamIndex: 0, fromFile: true }],
  );
  assert.equal(disagreed[0]?.layout, "2.0");
  assert.equal(disagreed[0]?.codec, "AAC");
  assert.equal(disagreed[0]?.conflict, "The file is Dolby Digital 5.1. Plex says AAC 2.0.");
  const same = crossCheckAudio(
    [{ language: "English", layout: "5.1(side)", codec: "AC3", streamIndex: 0 }],
    [{ language: "English", layout: "5.1", codec: "Dolby Digital", streamIndex: 0, fromFile: true }],
  );
  assert.equal(same[0]?.conflict, undefined);
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
  assert.equal(
    presenceTooltip({ plex: true, radarr: true, sonarr: null }),
    "Plex: present\nRadarr: present\nFile scan: not scanned",
  );
  assert.equal(
    presenceTooltip({ plex: true, radarr: null, sonarr: true }),
    "Plex: present\nSonarr: present\nFile scan: not scanned",
  );
  const movie = fileHoverSources(
    { kind: "movie", inPlex: true, inRadarr: true, inSonarr: false, inBazarr: true },
    ["radarr", "sonarr", "bazarr"],
  );
  assert.equal(movie.radarr, true);
  assert.equal("sonarr" in movie, false);
  const episode = fileHoverSources(
    { inPlex: true, inSonarr: true, inBazarr: false },
    ["radarr", "sonarr", "bazarr"],
  );
  assert.equal(episode.sonarr, true);
  assert.equal("radarr" in episode, false);
  const versions = versionsFrom(noted);
  assert.equal(versions[0]?.presence?.plex, true);
});
