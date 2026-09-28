import assert from "node:assert/strict";
import test from "node:test";
import { listPlexLibraries, plexLibraryFolders } from "@/lib/connectors/plex";

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

test("folder scan can start from the movie and show folders Plex is watching", () => {
  const folders = plexLibraryFolders({
    MediaContainer: {
      Directory: [
        { key: "1", type: "movie", title: "Films", Location: [{ path: "/mnt/media/Movies" }, { path: "/mnt/media/Movies" }] },
        { key: "2", type: "show", title: "Series", Location: [{ path: "/mnt/media/TV" }] },
        { key: "3", type: "artist", title: "Music", Location: [{ path: "/mnt/media/Music" }] },
        { key: "4", type: "movie", title: "Archive", Location: [{ path: "/mnt/media/Archive" }] },
      ],
    },
  }, ["4"]);
  assert.deepEqual(folders, [
    { path: "/mnt/media/Movies", library: "Films" },
    { path: "/mnt/media/TV", library: "Series" },
  ]);
});
