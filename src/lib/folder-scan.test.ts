import assert from "node:assert/strict";
import test from "node:test";
import { chooseMatch, cleanRoots, filesRepresentingFolders, folderDraft, formatRefreshPaths, tracksFromProbe } from "@/lib/folder-scan";
import { sourceDraft } from "@/lib/source";

test("a probe report becomes audio and subtitle tracks in file order", () => {
  const probed = tracksFromProbe({
    streams: [
      { codec_type: "video", codec_name: "h264" },
      { codec_type: "audio", codec_name: "ac3", channels: 6, channel_layout: "5.1(side)", tags: { language: "por" } },
      { codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle", tags: { language: "ces" } },
    ],
  });
  assert.equal(probed?.audio[0]?.language, "Portuguese");
  assert.equal(probed?.audio[0]?.codec, "Dolby Digital");
  assert.equal(probed?.audio[0]?.layout, "5.1");
  assert.equal(probed?.audio[0]?.fromFile, true);
  assert.equal(probed?.audio[0]?.streamIndex, 0);
  assert.equal(probed?.subtitles[0]?.language, "Czech");
  assert.equal(probed?.subtitles[0]?.format, "PGS");
});

test("a scanned file takes the Radarr identity for the same path", () => {
  const radarr = sourceDraft({
    connector: "radarr",
    kind: "movie",
    externalKey: "12",
    title: "The Adjustment Bureau",
    year: 2011,
    imdbId: "tt1385826",
    path: "/mnt/media/Movies/The Adjustment Bureau (2011)/50201.m2ts",
  });
  const plex = sourceDraft({
    connector: "plex",
    kind: "movie",
    externalKey: "item:1",
    title: "The Adjustment Bureau",
    year: 2011,
    path: "/mnt/media/Movies/The Adjustment Bureau (2011)/50201.m2ts",
  });
  const match = chooseMatch([plex, radarr], "/mnt/media/Movies/The Adjustment Bureau (2011)/50201.m2ts");
  assert.equal(match?.connector, "radarr");
  const draft = folderDraft("/mnt/media/Movies/The Adjustment Bureau (2011)/50201.m2ts", {
    audio: [{ language: "Portuguese", layout: null, codec: null, streamIndex: 0, fromFile: true }],
    subtitles: [],
  }, match);
  assert.equal(draft.connector, "files");
  assert.equal(draft.imdbId, "tt1385826");
  assert.equal(draft.title, "The Adjustment Bureau");
  assert.equal(draft.files[0]?.audioTracks?.[0]?.language, "Portuguese");
  assert.throws(() => cleanRoots(["Movies"]), /full path/);
});

test("another stream in the same movie folder keeps that movie", () => {
  const radarr = sourceDraft({
    connector: "radarr",
    kind: "movie",
    externalKey: "9",
    title: "Fight Club",
    year: 1999,
    imdbId: "tt0137523",
    path: "/mnt/media/Movies/Fight Club (1999)/Fight Club (USA - 1999) BD50/BDMV/STREAM/00059.m2ts",
  });
  const file = "/mnt/media/Movies/Fight Club (1999)/Fight Club (USA - 1999) BD50/BDMV/STREAM/00366.m2ts";
  const match = chooseMatch([radarr], file, ["/mnt/media/Movies"]);
  assert.equal(match?.title, "Fight Club");
  const draft = folderDraft(file, { audio: [], subtitles: [] }, match);
  assert.equal(draft.kind, "movie");
  assert.equal(draft.imdbId, "tt0137523");
  assert.equal(draft.title, "Fight Club");
});

test("a movie folder name matches the title when the stored path is empty", () => {
  const radarr = sourceDraft({
    connector: "radarr",
    kind: "movie",
    externalKey: "4",
    title: "Patriot Games",
    year: 1992,
    imdbId: "tt0105112",
  });
  const file = "/mnt/media/Movies/Patriot Games (1992)/Patriot.Games.1992.COMPLETE.UHD.BLURAY-WhiteRhino/BDMV/STREAM/00000.m2ts";
  const match = chooseMatch([radarr], file, ["/mnt/media/Movies"]);
  assert.equal(match?.imdbId, "tt0105112");
  const draft = folderDraft(file, { audio: [], subtitles: [] }, match);
  assert.equal(draft.title, "Patriot Games");
  assert.equal(draft.year, 1992);
  const unnamed = folderDraft(file, { audio: [], subtitles: [] }, null);
  assert.equal(unnamed.title, "Patriot Games");
  assert.equal(unnamed.year, 1992);
});

test("a differently named episode stays on its series", () => {
  const elsewhere = sourceDraft({
    connector: "plex",
    kind: "episode",
    externalKey: "episode:4",
    title: "Who Knew?",
    seriesTitle: "7th Heaven",
    year: 1996,
    season: 2,
    episode: 4,
    tvdbId: "73928",
    parentKey: "plex:plex://show/abc",
    path: "/mnt/media/TV/7th heaven/7th Heaven s2e04 - Who Knew.avi",
  });
  const sibling = sourceDraft({
    connector: "plex",
    kind: "episode",
    externalKey: "episode:30",
    title: "It Takes Two, Baby",
    seriesTitle: "7th Heaven",
    year: 1996,
    season: 3,
    episode: 1,
    tvdbId: "73928",
    parentKey: "plex:plex://show/abc",
    path: "/mnt/media/TV/Hetedik mennyorszag S01-S11/Hetedik Mennyorszag S03/7th.Heaven S03E01.avi",
  });
  const named = "/mnt/media/TV/Hetedik mennyorszag S01-S11/Hetedik Mennyorszag S02/7th.Heaven.S02E04.avi";
  const byName = chooseMatch([elsewhere], named, ["/mnt/media/TV"]);
  assert.equal(byName?.title, "Who Knew?");
  assert.equal(byName?.season, 2);
  const byFolder = chooseMatch([sibling, elsewhere], "/mnt/media/TV/Hetedik mennyorszag S01-S11/Hetedik Mennyorszag S02/show.S02E04.avi", ["/mnt/media/TV"]);
  assert.equal(byFolder?.title, "Who Knew?");
  const draft = folderDraft(named, { audio: [], subtitles: [] }, byName);
  assert.equal(draft.kind, "episode");
  assert.equal(draft.seriesTitle, "7th Heaven");
  assert.equal(draft.episode, 4);
});

test("numbered disc streams follow the movie folder they are in", () => {
  const jaws = "/mnt/media/Movies/Jaws (1975)/BDMV/STREAM/";
  const files = [
    `${jaws}00294.m2ts`,
    `${jaws}00000.m2ts`,
    `${jaws}00012.m2ts`,
    "/mnt/media/Movies/Heat (1995)/Heat.mkv",
  ];
  const known = sourceDraft({
    connector: "plex",
    kind: "movie",
    externalKey: "item:jaws",
    title: "Jaws",
    year: 1975,
    imdbId: "tt0073195",
    path: `${jaws}00294.m2ts`,
  });
  const kept = filesRepresentingFolders(files, [known]);
  assert.deepEqual(kept.filter((file) => file.includes("Jaws")), [`${jaws}00294.m2ts`]);
  assert.ok(kept.includes("/mnt/media/Movies/Heat (1995)/Heat.mkv"));
  const draft = folderDraft(`${jaws}00000.m2ts`, { audio: [], subtitles: [] }, null);
  assert.equal(draft.title, "Jaws");
  assert.equal(draft.year, 1975);
});

test("a file in a different movie folder is not claimed", () => {
  const radarr = sourceDraft({
    connector: "radarr",
    kind: "movie",
    externalKey: "9",
    title: "Fight Club",
    year: 1999,
    imdbId: "tt0137523",
    path: "/mnt/media/Movies/Fight Club (1999)/Fight Club.mkv",
  });
  const match = chooseMatch([radarr], "/mnt/media/Movies/Heat (1995)/Heat.mkv", ["/mnt/media/Movies"]);
  assert.equal(match, null);
});

test("a probed format is sent back to an app that does not have it", () => {
  const file = {
    container: "mkv",
    path: "/movies/Film.mkv",
    qualityName: null,
    resolution: null,
    hdr: "none" as const,
    is3d: false,
    audioLanguages: ["English"],
    subtitleLanguages: [],
  };
  const plex = sourceDraft({
    connector: "plex",
    kind: "movie",
    externalKey: "1",
    title: "Film",
    path: "/movies/Film.mkv",
    files: [{ ...file, audioTracks: [{ language: "English", layout: null, codec: null, streamIndex: 0 }] }],
  });
  const scanned = sourceDraft({
    connector: "files",
    kind: "movie",
    externalKey: "path:/movies/film.mkv",
    title: "Film",
    path: "/movies/Film.mkv",
    files: [{ ...file, audioTracks: [{ language: "English", layout: "5.1", codec: "Dolby Digital", streamIndex: 0, fromFile: true }] }],
  });
  assert.deepEqual(formatRefreshPaths([plex], [scanned]), ["/movies/Film.mkv"]);
  const named = sourceDraft({
    ...plex,
    files: [{ ...file, audioTracks: [{ language: "English", layout: "5.1", codec: "Dolby Digital", streamIndex: 0 }] }],
  });
  assert.deepEqual(formatRefreshPaths([named], [scanned]), []);
});
