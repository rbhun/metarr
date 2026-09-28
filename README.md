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

The app listens on port **4317**. SQLite is stored in the `metarr-data` volume. `docker-compose.yml` also mounts `/mnt/media` read-write so disc remux can read ISO/DVD folders and write the MKV beside them. Change that volume if your library lives elsewhere.

Settings live in `/opt/metarr/.env`; the first deploy copies it from `metarr.env.example`:

| Setting | Default | Why |
| --- | --- | --- |
| `METARR_UID` | `1500` | Dedicated media user. Not 1000, which maps to a restricted account on the NFS server. |
| `METARR_GID` | `1002` | Group `media`, which gives write access to `/mnt/media`. |
| `UMASK` | `002` | New files stay group-writable, so Radarr and Sonarr can manage them. |
| `METARR_DRY_RUN` | `0` | `1` makes remux and file tagging report what they would change without writing to media. |
| `METARR_SCRATCH` | `/mnt/media/.metarr-work` | Work folder for remux and MP4 retagging, on the NAS and outside every library folder. A Blu-ray remux needs up to about 50 GB. |

These apply to the whole app. The language detection tagger (mkvpropedit, MP4 retag, subtitle renames) writes as the same user, group and umask as remux, and follows the same dry-run switch.

How Metarr treats the library:

- **Scratch is on the NAS, outside the libraries.** MakeMKV and MP4 retagging write into `METARR_SCRATCH`. Metarr only removes its own `remux-work/job-N` and `retag-work/job-*` folders there.
- **Files are delivered in two steps.** A finished file is moved to `<target>.partial` in the destination folder (a rename on the same share, a copy otherwise), flushed, then renamed to its final name, so Plex and the *arr apps never see half-written files. An existing file is never overwritten, and the disc it came from is left in place.
- **Plex keeps priority.** Tools run under `ionice -c3` and `nice -n 19`, the container has a low CPU weight, and jobs run one at a time.
- **Every track is kept.** Remux keeps every audio and subtitle track in disc order, including Hungarian, with their language tags. The only thing dropped is the 3D video layer.
- **Plex, Radarr and Sonarr are told about new files through their APIs.** After a remux, Metarr asks Plex for a partial scan of that folder only, and asks Radarr or Sonarr to rescan the movie or series that owns the folder. Plex's database and Application Support folder are never touched.

On the machine that already has the checkout, `deploy.sh` pulls, rebuilds, and checks that the container can write one test file in a movie folder:

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

Checkboxes select titles on the current page and individual episode files. **Copy titles and paths** copies that list in the browser. Sync reads metadata from each app. **Queue disc remux** (and the **Rips** page) asks MakeMKV, on this machine, to write an MKV next to the selected disc.

## Language detection

Unknown audio is sampled with Whisper. Unknown subtitles are read as text, or as pictures when they are PGS or VobSub. When a language is recognized, it is written into the file:

- Matroska (MKV and WebM) is tagged in place with `mkvpropedit`. A commentary track also gets the commentary flag.
- MP4 and MOV are copied with the same video and audio so the language tag can be set. This needs free space for a second copy of the file.
- A subtitle file beside the video is renamed so the language code is in the name, for example `Film.hun.srt`.

Plex is then asked to analyze the file, which is how the new language gets into Plex’s database. Radarr and Sonarr are asked to rescan, which updates their media info. Bazarr is asked to scan the disk when the track was a subtitle. Plex and the *arr apps take the language from the file when they re-read it.

## Disc remux

Open **Rips** from the sidebar (or go to `/rips`). Disc images already in the library (ISO, `VIDEO_TS`, or `BDMV`) are listed there. Select them and choose **Send for remux**, or paste a path on this machine. Optional **Keep extras** saves every other title as well. The original disc stays where it is.

Progress, waiting jobs, and failure reasons show on **Tasks** (filter **Rips**). You can also select disc images in the Library and choose **Queue disc remux**. Both paths use the same overnight queue.

The queue runs one disc at a time. The next starts when the previous one finishes, and only between the start and end hour in Settings (01:00–07:00 by default). A disc that has already started is left to finish. The next one waits if the window has closed, if Plex is scanning or someone is playing, or if language detection is reading a file. On Linux the remux runs at idle disk priority.

MakeMKV copies every audio language, commentary track, and subtitle into the MKV. It does not re-encode them. The 3D MVC video track is left out. The longest title is saved as `Title (Year).mkv` in the disc’s folder. With extras on, the other titles are `Title (Year)-other.mkv`, `Title (Year)-other2.mkv`, and so on, in that same folder, which Plex lists as extras. Disc menus are not included.

The Docker image builds MakeMKV (headless, version set by the `MAKEMKV_VERSION` build argument), so nothing needs installing on the host. Paste the MakeMKV key in Settings; it stays in the local database. Without Docker, install MakeMKV yourself and put `makemkvcon` on `PATH` or set its path in Settings. Path mapping from language detection is used when a Plex path is not a file on this machine. With Docker, the media folder must be mounted at the same path Metarr sees (default `/mnt/media`).

## Online sources

In Settings, add a TMDB key, an OMDb key, or both, and turn **Use when looking up** on. On the library page, **Fill missing metadata** looks up titles that have not been found yet. **Look up selected** and the detail panel refresh specific titles. OMDb supplies the rating when both sources match. A title the sources cannot match is left as-is and is not retried until you look it up again.

## Out of scope

TVDB keys, Lidarr, Readarr, Prowlarr, downloading media, writing posters or ratings back to Plex or the *arr apps, user accounts, and Plex OAuth. Recognized track languages are written into the media file, and those apps are asked to re-read the file.
