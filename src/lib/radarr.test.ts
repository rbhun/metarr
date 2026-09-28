import assert from "node:assert/strict";
import test from "node:test";
import { parseRadarrMovie } from "@/lib/connectors/radarr";

test("a Radarr file language is kept when the audio field is blank", () => {
  const parsed = parseRadarrMovie({
    id: 33,
    title: "10 Things I Hate About You",
    year: 1999,
    hasFile: true,
    movieFile: {
      path: "/movies/10 Things.avi",
      languages: [{ id: 1, name: "English" }],
      mediaInfo: { audioLanguages: "", audioCodec: "MP3" },
    },
  });
  assert.deepEqual(parsed?.audioLanguages, ["English"]);
});

test("a probed Radarr audio language wins over the file language", () => {
  const parsed = parseRadarrMovie({
    id: 1,
    title: "Dune",
    year: 2021,
    hasFile: true,
    movieFile: {
      path: "/movies/Dune.mkv",
      languages: [{ name: "English" }],
      mediaInfo: { audioLanguages: "Hungarian" },
    },
  });
  assert.deepEqual(parsed?.audioLanguages, ["Hungarian"]);
});

test("an unknown Radarr file language is not a track language", () => {
  const parsed = parseRadarrMovie({
    id: 2,
    title: "Blank",
    year: 2000,
    hasFile: true,
    movieFile: {
      path: "/movies/Blank.avi",
      languages: [{ name: "Unknown" }, { name: "Any" }],
      mediaInfo: { audioLanguages: "" },
    },
  });
  assert.deepEqual(parsed?.audioLanguages, []);
});
