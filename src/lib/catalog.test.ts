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
  assert.equal(avatar?.playable_label, "bluray");
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
    rules: [],
    q: "",
    offset: 0,
    limit: 50,
  };
  const names = (rules: LibraryQuery["rules"]) =>
    queryLibrary({ ...baseQuery, rules }, db).titles.map((title) => title.title);

  assert.deepEqual(names([{ id: "subs", field: "subtitles", op: "missing", value: "English" }]), ["Heat"]);
  assert.deepEqual(names([{ id: "3d", field: "stereo", op: "eq", value: "yes" }]), ["Gravity"]);
  assert.deepEqual(names([{ id: "hu", field: "language", op: "includes", value: "Hungarian" }]).sort(), ["Dune", "The Wire"]);
  assert.deepEqual(names([{ id: "pg", field: "contentRating", op: "eq", value: "PG" }]), ["The Godfather Part II"]);
  assert.deepEqual(names([{ id: "genre", field: "genre", op: "empty", value: "" }]), ["The Godfather Part II"]);
  assert.deepEqual(names([{ id: "br", field: "bitrate", op: "gt", value: "10" }]), ["The Godfather"]);
  assert.ok(names([{ id: "en", field: "audio", op: "excludes", value: "English" }]).includes("Parasite"));
  assert.ok(names([{ id: "mkv", field: "container", op: "eq", value: "mkv" }]).includes("The Godfather"));
  assert.ok(names([{ id: "sdr", field: "hdr", op: "eq", value: "sdr" }]).includes("The Godfather"));
  assert.ok(!names([{ id: "sdr", field: "hdr", op: "eq", value: "sdr" }]).includes("Dune"));

  db.prepare(
    `UPDATE catalog_episodes
     SET subtitle_languages = '[]'
     WHERE episode = 1
       AND catalog_id = (SELECT id FROM catalog_titles WHERE title = 'The Wire')`,
  ).run();
  assert.deepEqual(names([{ id: "subs", field: "subtitles", op: "missing", value: "English" }]).sort(), ["Heat", "The Wire"]);
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

test("both resolutions of one movie stay on the title", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, [
    withMedia(
      sourceDraft({
        connector: "plex",
        kind: "movie",
        externalKey: "item:tenet",
        title: "Tenet",
        year: 2020,
      }),
      [
        {
          container: "mkv",
          path: "/movies/Tenet.2020.IMAX.2160p.HDR.mkv",
          qualityName: null,
          resolution: "2160p",
          hdr: "HDR10",
          is3d: false,
          audioLanguages: ["English"],
          subtitleLanguages: ["English"],
        },
        {
          container: "mkv",
          path: "/movies/Tenet.2020.2160p.AAC.mkv",
          qualityName: null,
          resolution: "2160p",
          hdr: "none",
          is3d: false,
          audioLanguages: [],
          subtitleLanguages: [],
        },
      ],
    ),
  ]);
  rebuildCatalog(db);
  const row = db.prepare(`SELECT resolution, hdr, version_resolutions, version_hdrs, versions_json FROM catalog_titles WHERE title = 'Tenet'`).get() as {
    resolution: string;
    hdr: string;
    version_resolutions: string;
    version_hdrs: string;
    versions_json: string;
  };
  assert.equal(row.resolution, "2160p");
  assert.equal(row.hdr, "HDR10");
  assert.match(row.version_hdrs, /none/);
  assert.equal(JSON.parse(row.versions_json).length, 2);
  const library = queryLibrary({ kind: "all", q: "Tenet", rules: [{ id: "hdr", field: "hdr", op: "eq", value: "SDR" }], offset: 0, limit: 10 }, db);
  assert.equal(library.titles.length, 1);
  assert.equal(library.titles[0]?.versions.length, 2);
  db.close();
});

test("the same file from Plex and Bazarr is one version", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, [
    withMedia(
      sourceDraft({
        connector: "plex",
        kind: "movie",
        externalKey: "item:ten",
        title: "10 Things",
        year: 1999,
        imdbId: "tt0147800",
      }),
      [
        {
          container: "avi",
          path: "/mnt/media/Movies/10 Things.avi",
          qualityName: null,
          resolution: "352p",
          hdr: "none",
          is3d: false,
          audioLanguages: [],
          subtitleLanguages: ["English"],
          audioTracks: [{ language: null, layout: "2.0", codec: "MP3" }],
          subtitleTracks: [{ language: "English", placement: "external", format: "SRT", forced: false }],
          bitrateKbps: 1033,
        },
      ],
    ),
    sourceDraft({
      connector: "bazarr",
      kind: "movie",
      externalKey: "radarr:33",
      title: "10 Things",
      year: 1999,
      imdbId: "tt0147800",
      hasFile: true,
      path: "/mnt/media/Movies/10 Things.avi",
      container: "avi",
      audioLanguages: ["English"],
      subtitleLanguages: ["English", "Hungarian"],
    }),
  ]);
  rebuildCatalog(db);
  const row = db.prepare(`SELECT versions_json FROM catalog_titles WHERE title = '10 Things'`).get() as { versions_json: string };
  const versions = JSON.parse(row.versions_json) as Array<{
    resolution: string | null;
    audioTracks: Array<{ language: string | null }>;
    subtitleLanguages: string[];
  }>;
  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.resolution, "352p");
  assert.equal(versions[0]?.audioTracks[0]?.language, null);
  assert.deepEqual(versions[0]?.subtitleLanguages, ["English", "Hungarian"]);
  db.close();
});
