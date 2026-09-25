# Metarr

Local metadata overview for Plex, Radarr, Sonarr, and Bazarr. Metarr downloads library records only — titles, files, quality, languages, ratings, and what is missing — and stores them in SQLite on this machine. It never copies video or subtitle files.

There is no login on Metarr itself. Paste each server’s base URL and key in Settings. Unused apps stay disconnected.

## Run with npm

```bash
npm install
npm run dev
```

Open [http://localhost:4317](http://localhost:4317). The dev server listens on port **4317**.

`npm test` checks matching, playable labels, and the demo catalog. `npm run build && npm start` serves a production build on the same port.

The database file is `data/library.db` unless `DATABASE_PATH` is set. See `.env.example`. That file is gitignored.

## Run with Docker

```bash
docker compose up --build
```

The app listens on port **4317**. SQLite is stored in the `metarr-data` volume.

## Settings

Open **Settings** from the sidebar (or go to `/settings`).

| App | Auth |
| --- | --- |
| Plex | Base URL + `X-Plex-Token` |
| Radarr | Base URL + API key (`X-Api-Key`, v3) |
| Sonarr | Base URL + API key (`X-Api-Key`, v3) |
| Bazarr | Base URL + API key (`X-Api-Key`) |

Turn on **Include in sync** for each server you want to read, then use **Sync metadata**. Progress and per-app errors show in the sync dialog. If one app fails, its previous successful rows stay. Music and photo libraries in Plex are skipped.

**Load demo library** fills the table with sample titles (including The Godfather Part II with no file) without contacting a server. It does not change saved URLs or keys. A successful live sync replaces the sample.

## What the table shows

One row per movie or series. Match across apps uses IMDb, TMDB, TVDB, and GUID first, then title + year. Columns cover container, Plex, each connected \*arr app, playable state (video file, disc image, or missing file), resolution, Radarr/Sonarr quality, 3D, HDR, audio languages, subtitles (including Bazarr’s missing list), rating, and genres. Ratings and genres come from the apps when they already stored them. TMDB and OMDb can fill a poster, overview, runtime, and any rating or genres that are still blank. Those lookups stay in the local database and are not written back. Disc images (`iso`, `img`, or a path containing `VIDEO_TS` / `BDMV`) are marked not playable. Missing Radarr movies and incomplete Sonarr series stay in the list even when Plex does not have them.

Filters: movies, series, missing, not in Plex, disc / not playable, missing English subtitles, 3D only, Hungarian, and title search.

Missing English subtitles matches a movie file whose subtitle list does not include English, a series episode file in the same state, or any row where Bazarr wants English. Titles with no file stay out of that filter unless Bazarr lists English as wanted. Hungarian matches audio, existing subtitles, or a Bazarr wanted language on the title or an episode. 3D only uses the 3D flag already stored from media info or the title.

Checkboxes select titles on the current page and individual episode files. **Copy titles and paths** copies that list in the browser. Metarr only reads metadata: sync, test, and the library page do not rename, delete, move, or update files on Plex or the *arr apps.

## Online sources

In Settings, add a TMDB key, an OMDb key, or both, and turn **Use when looking up** on. On the library page, **Fill missing metadata** looks up titles that have not been found yet. **Look up selected** and the detail panel refresh specific titles. OMDb supplies the rating when both sources match. A title the sources cannot match is left as-is and is not retried until you look it up again.

## Out of scope

TVDB keys, Lidarr, Readarr, Prowlarr, downloading media, writing metadata back to Plex or the *arr apps, user accounts, and Plex OAuth.
