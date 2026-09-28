import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { paintFileSources, paintTrackList } from "@/lib/detect/refresh";
import { migrate } from "@/lib/db";

test("a refreshed file language is stored on that track", () => {
  const tracks = [{ language: "English", streamIndex: 0, sources: { plex: null } }];
  assert.equal(
    paintTrackList(tracks, "audio", {
      radarrAudio: ["English"],
      plexAudio: [null],
    }),
    true,
  );
  assert.deepEqual(tracks[0]?.sources, { plex: null, radarr: "English" });
});

test("a source that was not re-read keeps its previous line", () => {
  const tracks = [{ language: "English", streamIndex: 0, sources: { plex: null, file: null } }];
  paintTrackList(tracks, "audio", { radarrAudio: [] });
  assert.deepEqual(tracks[0]?.sources, { plex: null, file: null, radarr: null });
});

test("the library row for that file keeps the refreshed languages", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO catalog_titles (
      kind, title, sort_title, playable_label, path, audio_tracks, subtitle_tracks, versions_json
    ) VALUES ('movie', 'Dune', 'dune', 'video', '/movies/Dune.mkv', ?, '[]', ?)`,
  ).run(
    JSON.stringify([{ language: "English", streamIndex: 0, sources: { plex: null } }]),
    JSON.stringify([
      {
        path: "/movies/Other.mkv",
        audioTracks: [{ language: "English", streamIndex: 0, sources: { plex: null } }],
        subtitleTracks: [],
      },
    ]),
  );
  paintFileSources(db, "/movies/Dune.mkv", { radarrAudio: ["English"], plexAudio: ["English"] });
  const row = db.prepare(`SELECT audio_tracks, versions_json FROM catalog_titles`).get() as {
    audio_tracks: string;
    versions_json: string;
  };
  const audio = JSON.parse(row.audio_tracks) as Array<{ sources: { plex: string; radarr: string } }>;
  assert.equal(audio[0]?.sources.plex, "English");
  assert.equal(audio[0]?.sources.radarr, "English");
  const other = JSON.parse(row.versions_json) as Array<{ audioTracks: Array<{ sources: { plex: string | null } }> }>;
  assert.equal(other[0]?.audioTracks[0]?.sources.plex, null);
  db.close();
});
