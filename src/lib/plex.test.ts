import assert from "node:assert/strict";
import test from "node:test";
import { applyDetailedItems, parsePlexItem } from "@/lib/connectors/plex";

const movie = {
  ratingKey: "10",
  type: "movie",
  title: "Dune",
  year: 2021,
  rating: 8.1,
  duration: 9_360_000,
  thumb: "/library/metadata/10/thumb/99",
  Genre: [{ tag: "Science Fiction" }],
  Media: {
    videoResolution: "1080",
    container: "mkv",
    bitrate: 8000,
    videoFrameRate: "24p",
    aspectRatio: 1.78,
    Part: {
      file: "/movies/Dune.mkv",
      size: 5_000_000_000,
      container: "mkv",
      Stream: [
        { streamType: "1", displayTitle: "1080p (HEVC)", codec: "hevc", frameRate: 23.976, bitDepth: 8, width: 1920, height: 1080 },
        { streamType: 2, language: "English", languageTag: "en", channels: 6, codec: "eac3", displayTitle: "English (EAC3 5.1)" },
        { streamType: "3", displayTitle: "Hungarian (SRT)", codec: "srt", index: 2 },
        { streamType: 3, language: "English", codec: "srt", index: -1, displayTitle: "English (SRT External)" },
      ],
    },
  },
};

test("plex movie streams become audio and subtitle languages", () => {
  const parsed = parsePlexItem(movie);
  assert.ok(parsed);
  assert.deepEqual(parsed.audioLanguages, ["English"]);
  assert.deepEqual(parsed.audioTracks, [{ language: "English", layout: "5.1", codec: "Dolby Digital Plus", streamIndex: 0 }]);
  assert.deepEqual(parsed.subtitleLanguages, ["Hungarian", "English"]);
  assert.equal(parsed.subtitleTracks[0]?.placement, "internal");
  assert.equal(parsed.subtitleTracks[0]?.format, "SRT");
  assert.equal(parsed.subtitleTracks[1]?.placement, "external");
  assert.equal(parsed.container, "mkv");
  assert.equal(parsed.resolution, "1080p");
  assert.equal(parsed.posterPath, "/library/metadata/10/thumb/99");
  assert.equal(parsed.runtimeMinutes, 156);
  assert.deepEqual(parsed.genres, ["Science Fiction"]);
  assert.equal(parsed.rating, 8.1);
  assert.equal(parsed.files[0]?.frameRate, "23.976 fps");
  assert.equal(parsed.files[0]?.videoCodec, "HEVC");
  assert.equal(parsed.files[0]?.bitDepth, 8);
  assert.equal(parsed.files[0]?.aspectRatio, "1.78:1");
});

test("plex writes channel layout as x.y and leaves a missing language blank", () => {
  const parsed = parsePlexItem({
    ratingKey: "12",
    type: "movie",
    title: "Stereo",
    Media: {
      Part: {
        file: "/movies/Stereo.m4a",
        container: "mp4",
        Stream: [{ streamType: 2, channels: 2, codec: "aac", displayTitle: "Unknown (AAC Stereo)" }],
      },
    },
  });
  assert.equal(parsed?.audioTracks[0]?.language, null);
  assert.equal(parsed?.audioTracks[0]?.layout, "2.0");
  assert.equal(parsed?.audioTracks[0]?.streamIndex, 0);
});

test("plex uses the media audio summary when streams are missing", () => {
  const parsed = parsePlexItem({
    ratingKey: "11",
    type: "movie",
    title: "Arrival",
    Media: [{ videoResolution: "2160", audioChannels: 8, audioCodec: "truehd", container: "mkv", Part: [{ file: "/movies/Arrival.mkv", container: "mkv" }] }],
  });
  assert.deepEqual(parsed?.audioTracks, [{ language: null, layout: "7.1", codec: "Dolby TrueHD" }]);
});

test("listing items without streams are replaced by full metadata", () => {
  const listed = {
    ratingKey: "10",
    type: "movie",
    title: "Dune",
    Media: [{ container: "mkv", Part: [{ file: "/movies/Dune.mkv", container: "mkv", size: 5 }] }],
  };
  const [merged] = applyDetailedItems([listed], [movie]);
  const parsed = parsePlexItem(merged);
  assert.deepEqual(parsed?.audioLanguages, ["English"]);
  assert.deepEqual(parsed?.subtitleLanguages, ["Hungarian", "English"]);
});
