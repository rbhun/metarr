import assert from "node:assert/strict";
import test from "node:test";
import { clusterMatches, type Matchable } from "@/lib/match";

function item(partial: Partial<Matchable> & Pick<Matchable, "title">): Matchable {
  return {
    kind: "movie",
    year: 1972,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    guid: null,
    ...partial,
  };
}

test("shared imdb ids collapse to one title", () => {
  const groups = clusterMatches([
    item({ title: "The Godfather", imdbId: "tt0068646", guid: "plex://movie/1" }),
    item({ title: "The Godfather", imdbId: "tt0068646", tmdbId: "238" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.length, 2);
});

test("title and year attach a row that has no external id", () => {
  const groups = clusterMatches([
    item({ title: "Heat", year: 1995, imdbId: "tt0113277" }),
    item({ title: "Heat", year: 1995 }),
  ]);
  assert.equal(groups.length, 1);
});

test("different imdb ids stay split even when the title matches", () => {
  const groups = clusterMatches([
    item({ title: "The Office", year: 2005, imdbId: "tt0386676" }),
    item({ title: "The Office", year: 2005, imdbId: "tt0290978" }),
    item({ title: "The Office", year: 2005 }),
  ]);
  assert.equal(groups.length, 3);
});

test("movies and series do not share a tmdb id", () => {
  const groups = clusterMatches([
    item({ title: "Shared", year: 2000, tmdbId: "100", kind: "movie" }),
    item({ title: "Shared", year: 2000, tmdbId: "100", kind: "series" }),
  ]);
  assert.equal(groups.length, 2);
});
