import assert from "node:assert/strict";
import test from "node:test";
import { listPlexLibraries, plexFolderToScan, plexLibraryFolders } from "@/lib/connectors/plex";
import { pathOnPlex } from "@/lib/detect/paths";
import { uniqueScanFolders } from "@/lib/plex-scan";

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
    { path: "/mnt/media/Movies", library: "Films", key: "1" },
    { path: "/mnt/media/TV", library: "Series", key: "2" },
  ]);
});

test("a scan targets the movie or show folder, including a numbered disc stream", () => {
  const locations = [
    { key: "1", path: "/mnt/media/Movies" },
    { key: "2", path: "/mnt/media/TV" },
    { key: "4", path: "/mnt/media/Archive" },
  ];
  assert.deepEqual(
    plexFolderToScan(locations, "/mnt/media/Movies/Patriot Games (1992)/BDMV/STREAM/00000.m2ts"),
    { key: "1", path: "/mnt/media/Movies/Patriot Games (1992)" },
  );
  assert.deepEqual(
    plexFolderToScan(locations, "/mnt/media/TV/7th heaven/7th Heaven s2e04 - Who Knew.avi"),
    { key: "2", path: "/mnt/media/TV/7th heaven" },
  );
  assert.equal(plexFolderToScan(locations, "/mnt/other/Loose.mkv"), null);
  assert.deepEqual(plexFolderToScan(locations, "/mnt/media/Movies/loose.mkv"), { key: "1", path: "/mnt/media/Movies" });
});

test("several episodes of one show become one Plex scan", () => {
  assert.deepEqual(
    uniqueScanFolders([
      { key: "2", path: "/mnt/media/TV/Two and a Half Men" },
      { key: "2", path: "/mnt/media/TV/Two and a Half Men/" },
      { key: "1", path: "/mnt/media/Movies/Glass Tiger (2001)" },
    ]),
    [
      { key: "2", path: "/mnt/media/TV/Two and a Half Men" },
      { key: "1", path: "/mnt/media/Movies/Glass Tiger (2001)" },
    ],
  );
});

test("a local path is rewritten to the path Plex is watching", () => {
  assert.equal(
    pathOnPlex("/Users/media/Movies/Heat (1995)/Heat.mkv", [{ from: "/mnt/media", to: "/Users/media" }]),
    "/mnt/media/Movies/Heat (1995)/Heat.mkv",
  );
  assert.equal(pathOnPlex("/mnt/media/Movies/Heat.mkv", [{ from: "/mnt/media", to: "/Users/media" }]), "/mnt/media/Movies/Heat.mkv");
});
