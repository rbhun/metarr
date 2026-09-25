import assert from "node:assert/strict";
import test from "node:test";
import { listPlexLibraries } from "@/lib/connectors/plex";

test("Plex library list keeps movies and shows", () => {
  const libraries = listPlexLibraries({
    MediaContainer: {
      Directory: [
        { key: "1", type: "movie", title: "Films" },
        { key: "2", type: "show", title: "Series" },
        { key: "3", type: "artist", title: "Music" },
        { key: "4", type: "photo", title: "Photos" },
      ],
    },
  });
  assert.deepEqual(libraries, [
    { key: "1", title: "Films", type: "movie" },
    { key: "2", title: "Series", type: "show" },
  ]);
});
