# Metarr

Local metadata overview for Plex, Radarr, Sonarr, and Bazarr. Metarr downloads library records only — titles, files, quality, languages, ratings, and what is missing — and stores them in SQLite on this machine. Sync does not copy video or subtitle files. The disc remux queue is separate: it writes new MKV files beside a disc and leaves the disc in place.

There is no login on Metarr itself. Paste each server’s base URL and key in Settings. Unused apps stay disconnected.

## Version

The sidebar shows the current version. That number is the latest heading in `changes.md`, and it matches `src/lib/version.ts` and `package.json`.

Each change adds a section at the top of `changes.md` and increases the last number: `0.0.1`, `0.0.2`, and on past 100. The major and minor numbers change only when asked. Agents follow `.cursor/rules/changelog.mdc`.

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

On the machine that already has the checkout, `deploy.sh` pulls and rebuilds:

```bash
sudo /opt/metarr/deploy.sh
```

From another computer: `ssh <plex-vm> sudo /opt/metarr/deploy.sh`.

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

Checkboxes select titles on the current page and individual episode files. **Copy titles and paths** copies that list in the browser. Sync, test, and the library page do not rename, delete, move, or update files on Plex or the *arr apps. **Queue disc remux** is the exception: it asks MakeMKV, on this machine, to write an MKV next to the selected disc.

## Disc remux

Select disc images (ISO, `VIDEO_TS`, or `BDMV`) and choose **Queue disc remux**. Optional **Keep extras** saves every other title as well. The original disc stays where it is.

The queue runs one disc at a time. The next starts when the previous one finishes, and only between the start and end hour in Settings (01:00–07:00 by default). A disc that has already started is left to finish. The next one waits if the window has closed, if Plex is scanning or someone is playing, or if language detection is reading a file. On Linux the remux runs at idle disk priority.

MakeMKV copies every audio language, commentary track, and subtitle into the MKV. It does not re-encode them. The 3D MVC video track is left out. The longest title is saved as `Title (Year).mkv` in the disc’s folder. With extras on, the other titles are `Title (Year)-other.mkv`, `Title (Year)-other2.mkv`, and so on, in that same folder, which Plex lists as extras. Disc menus are not included.

Install MakeMKV on this machine, put `makemkvcon` on `PATH` or set its path in Settings, and paste the MakeMKV key there. The key stays in the local database. Path mapping from language detection is used when a Plex path is not a file on this machine.

## Online sources

In Settings, add a TMDB key, an OMDb key, or both, and turn **Use when looking up** on. On the library page, **Fill missing metadata** looks up titles that have not been found yet. **Look up selected** and the detail panel refresh specific titles. OMDb supplies the rating when both sources match. A title the sources cannot match is left as-is and is not retried until you look it up again.

## Out of scope

TVDB keys, Lidarr, Readarr, Prowlarr, downloading media, writing metadata back to Plex or the *arr apps, user accounts, and Plex OAuth.
