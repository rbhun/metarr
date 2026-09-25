import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { rebuildCatalog } from "@/lib/catalog";
import { insertSourceRecords, migrate, queryLibrary, type LibraryQuery } from "@/lib/db";
import { demoRecords } from "@/lib/demo";
import { sourceDraft, withMedia } from "@/lib/source";

function titles(db: Database.Database) {
  return db.prepare(`SELECT * FROM catalog_titles ORDER BY title`).all() as Array<{
    title: string;
    kind: string;
    in_plex: number;
    in_radarr: number;
    in_sonarr: number;
    in_bazarr: number;
    has_file: number;
    playable_label: string;
    hdr: string;
    is_3d: number;
    container: string | null;
    missing_reason: string | null;
    missing_episode_count: number;
    episode_count: number;
    rating: number | null;
    subtitle_wanted: string;
    quality_name: string | null;
  }>;
}

test("demo library keeps missing movies, disc images, and incomplete series", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, demoRecords());
  rebuildCatalog(db);
  const rows = titles(db);
  const byTitle = new Map(rows.map((row) => [row.title, row]));

  const partTwo = byTitle.get("The Godfather Part II");
  assert.ok(partTwo);
  assert.equal(partTwo.in_plex, 0);
  assert.equal(partTwo.in_radarr, 1);
  assert.equal(partTwo.has_file, 0);
  assert.equal(partTwo.playable_label, "missing");
  assert.match(partTwo.missing_reason ?? "", /No file in Radarr/);

  const godfather = byTitle.get("The Godfather");
  assert.equal(godfather?.in_plex, 1);
  assert.equal(godfather?.in_radarr, 1);
  assert.equal(godfather?.in_bazarr, 1);
  assert.equal(godfather?.playable_label, "video");
  assert.match(godfather?.container ?? "", /mkv/);
  assert.equal(godfather?.quality_name, "Bluray-1080p");

  const avatar = byTitle.get("Avatar");
  assert.equal(avatar?.playable_label, "disc");
  assert.equal(avatar?.in_plex, 1);

  const gravity = byTitle.get("Gravity");
  assert.equal(gravity?.is_3d, 1);
  assert.equal(gravity?.playable_label, "video");

  const dune = byTitle.get("Dune");
  assert.equal(dune?.hdr, "Dolby Vision");
  assert.equal(dune?.in_bazarr, 1);

  const matrix = byTitle.get("The Matrix");
  assert.equal(matrix?.in_plex, 1);
  assert.equal(matrix?.in_radarr, 0);
  assert.equal(matrix?.hdr, "HDR10");

  const parasite = byTitle.get("Parasite");
  assert.match(parasite?.subtitle_wanted ?? "", /Spanish/);

  const heat = byTitle.get("Heat");
  assert.equal(heat?.rating, null);
  assert.equal(heat?.in_plex, 0);
  assert.equal(heat?.has_file, 1);

  const wire = byTitle.get("The Wire");
  assert.equal(wire?.kind, "series");
  assert.equal(wire?.in_plex, 1);
  assert.equal(wire?.in_sonarr, 1);
  assert.equal(wire?.in_bazarr, 1);
  assert.equal(wire?.missing_episode_count, 1);
  assert.equal(wire?.episode_count, 4);
  assert.equal(wire?.playable_label, "video");

  const bear = byTitle.get("The Bear");
  assert.equal(bear?.in_plex, 0);
  assert.equal(bear?.missing_episode_count, 1);

  const chernobyl = byTitle.get("Chernobyl");
  assert.equal(chernobyl?.missing_episode_count, 0);
  assert.equal(chernobyl?.in_plex, 0);
  assert.equal(chernobyl?.hdr, "HDR10");

  const episodes = db
    .prepare(
      `SELECT e.season, e.episode, e.wanted, e.has_file FROM catalog_episodes e
       JOIN catalog_titles t ON t.id = e.catalog_id
       WHERE t.title = 'The Wire'
       ORDER BY episode`,
    )
    .all() as Array<{ season: number; episode: number; wanted: number; has_file: number }>;
  assert.deepEqual(
    episodes.map((episode) => [episode.episode, episode.has_file, episode.wanted]),
    [
      [1, 1, 0],
      [2, 1, 0],
      [3, 0, 1],
      [4, 0, 0],
    ],
  );

  const baseQuery: LibraryQuery = {
    kind: "all",
    missing: false,
    notInPlex: false,
    notPlayable: false,
    missingEnglish: false,
    only3d: false,
    hungarian: false,
    q: "",
    offset: 0,
    limit: 50,
  };
  const names = (query: Partial<LibraryQuery>) =>
    queryLibrary({ ...baseQuery, ...query }, db).titles.map((title) => title.title);

  assert.deepEqual(names({ missingEnglish: true }), ["Heat"]);
  assert.deepEqual(names({ only3d: true }), ["Gravity"]);
  assert.deepEqual(names({ hungarian: true }).sort(), ["Dune", "The Wire"]);

  db.prepare(
    `UPDATE catalog_episodes
     SET subtitle_languages = '[]'
     WHERE episode = 1
       AND catalog_id = (SELECT id FROM catalog_titles WHERE title = 'The Wire')`,
  ).run();
  assert.deepEqual(names({ missingEnglish: true }).sort(), ["Heat", "The Wire"]);
  db.close();
});

test("plex without ids still joins a radarr movie on title and year", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, [
    withMedia(
      sourceDraft({
        connector: "plex",
        kind: "movie",
        externalKey: "item:oldboy",
        title: "Oldboy",
        year: 2003,
      }),
      [
        {
          container: "mkv",
          path: "/movies/Oldboy.mkv",
          qualityName: null,
          resolution: "1080p",
          hdr: "none",
          is3d: false,
          audioLanguages: ["Korean"],
          subtitleLanguages: ["English"],
        },
      ],
    ),
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "9",
      title: "Oldboy",
      year: 2003,
      imdbId: "tt0364569",
      tmdbId: "670",
      wanted: true,
      rating: 8.3,
      genres: ["Thriller"],
    }),
  ]);
  rebuildCatalog(db);
  const rows = titles(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.in_plex, 1);
  assert.equal(rows[0]?.in_radarr, 1);
  assert.equal(rows[0]?.has_file, 1);
  assert.equal(rows[0]?.playable_label, "video");
  db.close();
});
