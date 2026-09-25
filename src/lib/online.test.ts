import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { rebuildCatalog } from "@/lib/catalog";
import { insertSourceRecords, migrate, queryLibrary, saveEnrichment } from "@/lib/db";
import { demoRecords } from "@/lib/demo";
import { lookupOnline } from "@/lib/online-lookup";
import { displayGenres, displayRating, enrichmentKey, mergeHits, type SourceHit } from "@/lib/online";

const godfather = {
  kind: "movie" as const,
  title: "The Godfather",
  year: 1972,
  imdbId: "tt0068646",
  tmdbId: "238",
  tvdbId: null,
};

function hit(partial: Partial<SourceHit> & Pick<SourceHit, "source">): SourceHit {
  return {
    overview: null,
    posterUrl: null,
    originalTitle: null,
    runtimeMinutes: null,
    rating: null,
    genres: [],
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    ...partial,
  };
}

test("enrichment key prefers an IMDb id", () => {
  assert.equal(enrichmentKey(godfather), "movie:imdb:tt0068646");
  assert.equal(
    enrichmentKey({ ...godfather, imdbId: null, tmdbId: null, title: "The Godfather" }),
    "movie:title:godfather:1972",
  );
});

test("merged lookup keeps the OMDb rating and the TMDB overview", () => {
  const merged = mergeHits([
    hit({
      source: "tmdb",
      overview: "Family saga.",
      posterUrl: "https://image.tmdb.org/t/p/w342/poster.jpg",
      runtimeMinutes: 175,
      rating: 8.7,
      genres: ["Drama", "Crime"],
      tmdbId: "238",
      imdbId: "tt0068646",
    }),
    hit({
      source: "omdb",
      overview: "Shorter plot.",
      rating: 9.2,
      genres: ["Crime"],
      imdbId: "tt0068646",
    }),
  ]);
  assert.equal(merged.status, "found");
  assert.equal(merged.overview, "Family saga.");
  assert.equal(merged.rating, 9.2);
  assert.deepEqual(merged.genres, ["Drama", "Crime"]);
  assert.deepEqual(merged.sources, ["tmdb", "omdb"]);
});

test("display helpers fill only blank library fields", () => {
  const online = mergeHits([hit({ source: "omdb", rating: 8.1, genres: ["Drama"] })]);
  assert.equal(displayRating(9.2, { ...online, fetchedAt: "" }).value, 9.2);
  assert.equal(displayRating(null, { ...online, fetchedAt: "" }).source, "OMDb");
  assert.equal(displayGenres(["Crime"], { ...online, fetchedAt: "" }).filled, false);
  assert.equal(displayGenres([], { ...online, fetchedAt: "" }).filled, true);
});

test("lookup uses TMDB details and then OMDb for the rating", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("themoviedb.org") && url.includes("/movie/238")) {
      return Response.json({
        id: 238,
        title: "The Godfather",
        original_title: "The Godfather",
        overview: "Family saga.",
        poster_path: "/poster.jpg",
        runtime: 175,
        vote_average: 8.7,
        genres: [{ name: "Drama" }, { name: "Crime" }],
        imdb_id: "tt0068646",
        external_ids: { imdb_id: "tt0068646", tvdb_id: null },
      });
    }
    if (url.includes("omdbapi.com")) {
      return Response.json({
        Response: "True",
        Title: "The Godfather",
        Year: "1972",
        Runtime: "175 min",
        Genre: "Crime, Drama",
        Plot: "Shorter plot.",
        Poster: "N/A",
        imdbRating: "9.2",
        imdbID: "tt0068646",
      });
    }
    return Response.json({ results: [] });
  };
  const result = await lookupOnline(godfather, { tmdb: "tmdb-key", omdb: "omdb-key" }, fetchImpl);
  assert.equal(result.status, "found");
  assert.equal(result.rating, 9.2);
  assert.equal(result.overview, "Family saga.");
  assert.match(result.posterUrl ?? "", /poster\.jpg/);
});

test("library rows attach saved online metadata", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertSourceRecords(db, demoRecords());
  rebuildCatalog(db);
  const key = enrichmentKey(godfather);
  saveEnrichment(
    key,
    "movie",
    {
      status: "found",
      sources: ["tmdb"],
      overview: "Family saga.",
      posterUrl: "https://image.tmdb.org/poster.jpg",
      originalTitle: "The Godfather",
      runtimeMinutes: 175,
      rating: 8.7,
      genres: ["Drama"],
      imdbId: "tt0068646",
      tmdbId: "238",
      tvdbId: null,
      message: null,
      fetchedAt: "2026-09-25T00:00:00.000Z",
    },
    db,
  );
  const library = queryLibrary(
    {
      kind: "all",
      missing: false,
      notInPlex: false,
      notPlayable: false,
      missingEnglish: false,
      only3d: false,
      hungarian: false,
      q: "Godfather",
      offset: 0,
      limit: 20,
    },
    db,
  );
  const row = library.titles.find((title) => title.title === "The Godfather");
  assert.equal(row?.online?.overview, "Family saga.");
  assert.equal(row?.online?.runtimeMinutes, 175);
  const partTwo = library.titles.find((title) => title.title === "The Godfather Part II");
  assert.equal(partTwo?.online, null);
});
