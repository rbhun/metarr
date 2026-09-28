import assert from "node:assert/strict";
import test from "node:test";
import { parseSonarrEpisode } from "@/lib/connectors/sonarr";
import { sourceDraft } from "@/lib/source";

test("a Sonarr file language is kept when the audio field is blank", () => {
  const series = sourceDraft({
    connector: "sonarr",
    kind: "series",
    externalKey: "4",
    title: "Ancient Megastructures",
    parentKey: "sonarr-series:4",
  });
  const parsed = parseSonarrEpisode(
    { id: 9, title: "Machu Picchu", seasonNumber: 1, episodeNumber: 7, hasFile: true, monitored: true, episodeFileId: 3 },
    series,
    {
      id: 3,
      path: "/tv/Show.mkv",
      languages: [{ id: 1, name: "Hungarian" }],
      mediaInfo: { audioLanguages: "", audioCodec: "AC3" },
    },
    new Set(),
  );
  assert.deepEqual(parsed?.audioLanguages, ["Hungarian"]);
});
