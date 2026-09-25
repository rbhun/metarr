import assert from "node:assert/strict";
import test from "node:test";
import { parseBazarrEpisode, parseBazarrMovie } from "@/lib/connectors/bazarr";
import { summarizeFiles } from "@/lib/media";

test("Bazarr 1.6 episodes keep the series title supplied by the series list", () => {
  const episode = parseBazarrEpisode({
    title: "Cat's in the Bag...",
    season: 1,
    episode: 2,
    sonarrEpisodeId: 264,
    sonarrSeriesId: 2,
    seriesTitle: "Breaking Bad",
    year: 2008,
    imdbId: "tt0903747",
    audio_language: [{ name: "English", code2: "en" }],
    subtitles: [],
    missing_subtitles: [{ name: "Hungarian", code2: "hu" }],
    monitored: true,
    path: "/mnt/media/TV/Breaking Bad/Season 1/Breaking Bad - S01E02.mkv",
  });
  assert.ok(episode);
  assert.equal(episode.path, "/mnt/media/TV/Breaking Bad/Season 1/Breaking Bad - S01E02.mkv");
  assert.deepEqual(episode.audioLanguages, []);
  assert.equal(episode.seriesTitle, "Breaking Bad");
  assert.equal(episode.season, 1);
  assert.equal(episode.episode, 2);
  assert.equal(episode.externalKey, "sonarr-episode:264");
  assert.deepEqual(episode.subtitleWanted, ["Hungarian"]);
});

test("Bazarr keeps a full DVD, Blu-ray, or ISO path instead of treating it as no file", () => {
  const cases = [
    ["/mnt/media/Movies/Amadeus (1984)/VIDEO_TS/VIDEO_TS.VOB", "vob", "dvd"],
    ["/mnt/media/Movies/Fight Club (1999)/Fight Club BD50/BDMV/STREAM/00059.m2ts", "m2ts", "bluray"],
    ["/mnt/media/Movies/Spaceballs (1987)/Spaceballs.iso", "iso", "iso"],
    ["/mnt/media/Movies/Spaceballs (1987)/Spaceballs.BD25.iso", "iso", "bluray-iso"],
    ["/mnt/media/Movies/Sample (2000)/Sample.DVDR.iso", "iso", "dvd-iso"],
    ["/mnt/media/Movies/Heat (1995)/Heat.mkv", "mkv", "video"],
  ] as const;
  for (const [path, container, label] of cases) {
    const movie = parseBazarrMovie({ title: "Sample", year: 1995, radarrId: 1, path });
    assert.ok(movie);
    assert.equal(movie.hasFile, true);
    assert.equal(movie.path, path);
    assert.equal(movie.container, container);
    assert.equal(summarizeFiles(movie.files).playableLabel, label);
  }
  const empty = parseBazarrMovie({ title: "Wanted only", radarrId: 2 });
  assert.equal(empty?.hasFile, false);
  assert.equal(empty?.path, null);
});
