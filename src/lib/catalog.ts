import type Database from "better-sqlite3";
import { clearCatalog, loadSourceRecords } from "@/lib/db";
import { clusterMatches, externalKeys, fallbackKey, type Matchable } from "@/lib/match";
import {
  bestHdr,
  detect3d,
  isAired,
  mergeLanguages,
  normalizeImdb,
  normalizeNumericId,
  normalizeTitle,
  resolutionRank,
  summarizeFiles,
  uniqueLanguages,
} from "@/lib/media";
import { enrichmentKey } from "@/lib/online";
import type { HdrLabel, MediaFile, SourceDraft, TitleKind } from "@/lib/types";

type SeriesBucket = {
  records: SourceDraft[];
  episodes: SourceDraft[];
  keys: Set<string>;
};

function matchable(record: SourceDraft, kind: TitleKind): SourceDraft & Matchable {
  return {
    ...record,
    kind,
    extraKeys: record.parentKey ? [record.parentKey] : [],
  };
}

function seriesKeys(records: SourceDraft[]): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of externalKeys(matchable(record, "series"))) keys.add(key);
    const fallback = fallbackKey("series", record.title, record.year);
    if (fallback) keys.add(`fallback:${fallback}`);
  }
  return keys;
}

function episodeKeys(episode: SourceDraft): string[] {
  const keys: string[] = [];
  if (episode.parentKey) keys.push(episode.parentKey);
  const imdb = normalizeImdb(episode.imdbId);
  if (imdb) keys.push(`imdb:series:${imdb}`);
  const tmdb = normalizeNumericId(episode.tmdbId);
  if (tmdb) keys.push(`tmdb:series:${tmdb}`);
  const tvdb = normalizeNumericId(episode.tvdbId);
  if (tvdb) keys.push(`tvdb:series:${tvdb}`);
  const seriesTitle = episode.seriesTitle || "";
  const fallback = fallbackKey("series", seriesTitle, episode.year);
  if (fallback) keys.push(`fallback:${fallback}`);
  return keys;
}

function firstText(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value && value.trim()) return value;
  }
  return null;
}

function firstRating(records: SourceDraft[]): number | null {
  for (const connector of ["plex", "radarr", "sonarr", "bazarr"] as const) {
    const found = records.find((record) => record.connector === connector && record.rating);
    if (found?.rating) return found.rating;
  }
  return records.find((record) => record.rating)?.rating ?? null;
}

function unionGenres(records: SourceDraft[]): string[] {
  const genres: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const genre of record.genres) {
      const key = genre.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      genres.push(genre);
    }
  }
  return genres;
}

function preferRecord(records: SourceDraft[], order: Array<SourceDraft["connector"]>): SourceDraft | undefined {
  for (const connector of order) {
    const found = records.find((record) => record.connector === connector);
    if (found) return found;
  }
  return records[0];
}

function filesFrom(records: SourceDraft[]): MediaFile[] {
  const files: MediaFile[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const own = record.files.length
      ? record.files
      : record.hasFile
        ? [
            {
              container: record.container,
              path: record.path,
              qualityName: record.qualityName,
              resolution: record.resolution,
              hdr: record.hdr,
              is3d: record.is3d,
              audioLanguages: record.audioLanguages,
              subtitleLanguages: record.subtitleLanguages,
            } satisfies MediaFile,
          ]
        : [];
    for (const file of own) {
      const key = `${file.path ?? ""}|${file.container ?? ""}|${file.resolution ?? ""}|${file.qualityName ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(file);
    }
  }
  return files;
}

function episodeGroupKey(episode: SourceDraft): string {
  if (episode.season != null && episode.episode != null) return `${episode.season}:${episode.episode}`;
  return `title:${normalizeTitle(episode.title)}`;
}

function episodeMissing(records: SourceDraft[]): boolean {
  const files = filesFrom(records);
  if (files.length > 0 || records.some((record) => record.hasFile)) return false;
  return records.some((record) => record.wanted || (record.monitored && isAired(record.airDate)));
}

type EpisodeInsert = {
  season: number | null;
  episode: number | null;
  title: string;
  hasFile: boolean;
  wanted: boolean;
  container: string | null;
  path: string | null;
  playableLabel: string;
  qualityName: string | null;
  resolution: string | null;
  hdr: HdrLabel;
  is3d: boolean;
  audioLanguages: string[];
  subtitleLanguages: string[];
  subtitleWanted: string[];
  inPlex: boolean;
  inSonarr: boolean;
  inBazarr: boolean;
  airDate: string | null;
};

function buildEpisode(records: SourceDraft[]): EpisodeInsert {
  const files = filesFrom(records);
  const summary = summarizeFiles(files, records.map((record) => record.title));
  const missing = episodeMissing(records);
  const audio = mergeLanguages(summary.audioLanguages, records.map((record) => record.audioLanguages).flat());
  const subtitles = mergeLanguages(
    summary.subtitleLanguages,
    records.flatMap((record) => record.subtitleLanguages),
  );
  const subtitleWanted = uniqueLanguages(records.flatMap((record) => record.subtitleWanted));
  const title = preferRecord(records, ["sonarr", "plex", "bazarr"])?.title || "Episode";
  const season = records.find((record) => record.season != null)?.season ?? null;
  const episode = records.find((record) => record.episode != null)?.episode ?? null;
  const airDate = records.find((record) => record.airDate)?.airDate ?? null;
  const hasFile = summary.hasFile || records.some((record) => record.hasFile && record.files.length === 0 && record.container);
  return {
    season,
    episode,
    title,
    hasFile: Boolean(hasFile) && summary.playableLabel !== "missing",
    wanted: missing,
    container: summary.container,
    path: summary.path,
    playableLabel: hasFile && summary.playableLabel !== "missing" ? summary.playableLabel : "missing",
    qualityName: summary.qualityName ?? firstText(records.map((record) => record.qualityName)),
    resolution: summary.resolution,
    hdr: summary.hdr === "none" ? bestHdr(records.map((record) => record.hdr)) : summary.hdr,
    is3d: summary.is3d || records.some((record) => record.is3d),
    audioLanguages: audio,
    subtitleLanguages: subtitles,
    subtitleWanted,
    inPlex: records.some((record) => record.connector === "plex"),
    inSonarr: records.some((record) => record.connector === "sonarr"),
    inBazarr: records.some((record) => record.connector === "bazarr"),
    airDate,
  };
}

function bestResolution(values: Array<string | null>): string | null {
  return values.reduce<string | null>((best, value) => {
    if (!value) return best;
    if (!best || resolutionRank(value) > resolutionRank(best)) return value;
    return best;
  }, null);
}

export function rebuildCatalog(db: Database.Database) {
  const records = loadSourceRecords(db);
  const movies = records.filter((record) => record.kind === "movie");
  const seriesRecords = records.filter((record) => record.kind === "series");
  const episodeRecords = records.filter((record) => record.kind === "episode");

  const movieGroups = clusterMatches(movies.map((record) => matchable(record, "movie")));
  const seriesGroups = clusterMatches(seriesRecords.map((record) => matchable(record, "series"))).map<SeriesBucket>(
    (group) => ({
      records: group,
      episodes: [],
      keys: seriesKeys(group),
    }),
  );

  for (const episode of episodeRecords) {
    const keys = episodeKeys(episode);
    let best: SeriesBucket | null = null;
    let bestScore = 0;
    for (const group of seriesGroups) {
      const score = keys.filter((key) => group.keys.has(key)).length;
      if (score > bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (!best) {
      best = { records: [], episodes: [], keys: new Set(keys) };
      seriesGroups.push(best);
    } else {
      for (const key of keys) best.keys.add(key);
    }
    best.episodes.push(episode);
  }

  const insertTitle = db.prepare(`
    INSERT INTO catalog_titles (
      kind, title, sort_title, year, imdb_id, tmdb_id, tvdb_id,
      in_plex, in_radarr, in_sonarr, in_bazarr, has_file, container, path,
      playable_label, playable_note, quality_name, resolution, hdr, is_3d,
      audio_languages, subtitle_languages, subtitle_wanted, rating, genres,
      missing_reason, episode_count, episode_file_count, missing_episode_count, match_key
    ) VALUES (
      @kind, @title, @sortTitle, @year, @imdbId, @tmdbId, @tvdbId,
      @inPlex, @inRadarr, @inSonarr, @inBazarr, @hasFile, @container, @path,
      @playableLabel, @playableNote, @qualityName, @resolution, @hdr, @is3d,
      @audioLanguages, @subtitleLanguages, @subtitleWanted, @rating, @genres,
      @missingReason, @episodeCount, @episodeFileCount, @missingEpisodeCount, @matchKey
    )
  `);
  const insertEpisode = db.prepare(`
    INSERT INTO catalog_episodes (
      catalog_id, season, episode, title, has_file, wanted, container, path,
      playable_label, quality_name, resolution, hdr, is_3d, audio_languages,
      subtitle_languages, subtitle_wanted, in_plex, in_sonarr, in_bazarr, air_date
    ) VALUES (
      @catalogId, @season, @episode, @title, @hasFile, @wanted, @container, @path,
      @playableLabel, @qualityName, @resolution, @hdr, @is3d, @audioLanguages,
      @subtitleLanguages, @subtitleWanted, @inPlex, @inSonarr, @inBazarr, @airDate
    )
  `);

  const write = db.transaction(() => {
    clearCatalog(db);

    for (const group of movieGroups) {
      const files = filesFrom(group);
      const summary = summarizeFiles(
        files,
        group.flatMap((record) => [record.title, record.path]),
      );
      const inRadarr = group.some((record) => record.connector === "radarr");
      const hasFile = summary.hasFile;
      const title = preferRecord(group, ["radarr", "plex", "bazarr"])?.title || "Untitled";
      const year = group.find((record) => record.year)?.year ?? null;
      const missingReason = hasFile ? null : inRadarr ? "No file in Radarr" : "No file";
      insertTitle.run({
        kind: "movie",
        title,
        sortTitle: normalizeTitle(title) || title.toLowerCase(),
        year,
        imdbId: firstText(group.map((record) => record.imdbId)),
        tmdbId: firstText(group.map((record) => record.tmdbId)),
        tvdbId: firstText(group.map((record) => record.tvdbId)),
        inPlex: group.some((record) => record.connector === "plex") ? 1 : 0,
        inRadarr: inRadarr ? 1 : 0,
        inSonarr: 0,
        inBazarr: group.some((record) => record.connector === "bazarr") ? 1 : 0,
        hasFile: hasFile ? 1 : 0,
        container: summary.container ?? firstText(group.map((record) => record.container)),
        path: summary.path,
        playableLabel: hasFile ? summary.playableLabel : "missing",
        playableNote: hasFile ? summary.playableNote : null,
        qualityName: summary.qualityName ?? firstText(group.map((record) => record.qualityName)),
        resolution: summary.resolution ?? bestResolution(group.map((record) => record.resolution)),
        hdr: summary.hdr === "none" ? bestHdr(group.map((record) => record.hdr)) : summary.hdr,
        is3d: summary.is3d || group.some((record) => record.is3d) ? 1 : 0,
        audioLanguages: JSON.stringify(
          mergeLanguages(summary.audioLanguages, group.flatMap((record) => record.audioLanguages)),
        ),
        subtitleLanguages: JSON.stringify(
          mergeLanguages(summary.subtitleLanguages, group.flatMap((record) => record.subtitleLanguages)),
        ),
        subtitleWanted: JSON.stringify(uniqueLanguages(group.flatMap((record) => record.subtitleWanted))),
        rating: firstRating(group),
        genres: JSON.stringify(unionGenres(group)),
        missingReason,
        episodeCount: 0,
        episodeFileCount: 0,
        missingEpisodeCount: 0,
        matchKey: enrichmentKey({
          kind: "movie",
          title,
          year,
          imdbId: firstText(group.map((record) => record.imdbId)),
          tmdbId: firstText(group.map((record) => record.tmdbId)),
          tvdbId: firstText(group.map((record) => record.tvdbId)),
        }),
      });
    }

    for (const group of seriesGroups) {
      if (group.records.length === 0 && group.episodes.length === 0) continue;
      const episodeGroups = new Map<string, SourceDraft[]>();
      for (const episode of group.episodes) {
        const key = episodeGroupKey(episode);
        const list = episodeGroups.get(key) ?? [];
        list.push(episode);
        episodeGroups.set(key, list);
      }
      const episodes = [...episodeGroups.values()].map(buildEpisode);
      const episodeFiles = filesFrom(group.episodes);
      const summary = summarizeFiles(
        episodeFiles,
        [...group.records.map((record) => record.title), ...group.episodes.map((record) => record.path)],
      );
      const named = preferRecord(group.records, ["sonarr", "plex", "bazarr"]);
      const title = named?.title || firstText(group.episodes.map((record) => record.seriesTitle)) || "Untitled series";
      const year = named?.year ?? group.records.find((record) => record.year)?.year ?? group.episodes.find((record) => record.year)?.year ?? null;
      const fileCount = episodes.filter((episode) => episode.hasFile).length;
      const missingCount = episodes.filter((episode) => episode.wanted).length;
      const hasFile = fileCount > 0 || summary.hasFile;
      const inSonarr = group.records.some((record) => record.connector === "sonarr") || episodes.some((episode) => episode.inSonarr);
      const inPlex = group.records.some((record) => record.connector === "plex") || episodes.some((episode) => episode.inPlex);
      const inBazarr = group.records.some((record) => record.connector === "bazarr") || episodes.some((episode) => episode.inBazarr);
      let missingReason: string | null = null;
      if (missingCount > 0) {
        missingReason = `${missingCount} episode${missingCount === 1 ? "" : "s"} missing`;
      } else if (!hasFile) {
        missingReason = "No episode files";
      }
      const identity = [...group.records, ...group.episodes];
      const result = insertTitle.run({
        kind: "series",
        title,
        sortTitle: normalizeTitle(title) || title.toLowerCase(),
        year,
        imdbId: firstText(identity.map((record) => record.imdbId)),
        tmdbId: firstText(identity.map((record) => record.tmdbId)),
        tvdbId: firstText(identity.map((record) => record.tvdbId)),
        inPlex: inPlex ? 1 : 0,
        inRadarr: 0,
        inSonarr: inSonarr ? 1 : 0,
        inBazarr: inBazarr ? 1 : 0,
        hasFile: hasFile ? 1 : 0,
        container: summary.container,
        path: summary.path,
        playableLabel: hasFile ? summary.playableLabel : "missing",
        playableNote: hasFile ? summary.playableNote : null,
        qualityName: summary.qualityName ?? firstText(group.episodes.map((record) => record.qualityName)),
        resolution: summary.resolution ?? bestResolution(episodes.map((episode) => episode.resolution)),
        hdr: summary.hdr === "none" ? bestHdr(episodes.map((episode) => episode.hdr)) : summary.hdr,
        is3d: summary.is3d || episodes.some((episode) => episode.is3d) || detect3d([title]) ? 1 : 0,
        audioLanguages: JSON.stringify(
          mergeLanguages(
            summary.audioLanguages,
            episodes.map((episode) => episode.audioLanguages).flat(),
          ),
        ),
        subtitleLanguages: JSON.stringify(
          mergeLanguages(
            summary.subtitleLanguages,
            episodes.flatMap((episode) => episode.subtitleLanguages),
          ),
        ),
        subtitleWanted: JSON.stringify(uniqueLanguages(episodes.flatMap((episode) => episode.subtitleWanted))),
        rating: firstRating(group.records),
        genres: JSON.stringify(unionGenres(group.records)),
        missingReason,
        episodeCount: episodes.length,
        episodeFileCount: fileCount,
        missingEpisodeCount: missingCount,
        matchKey: enrichmentKey({
          kind: "series",
          title,
          year,
          imdbId: firstText(identity.map((record) => record.imdbId)),
          tmdbId: firstText(identity.map((record) => record.tmdbId)),
          tvdbId: firstText(identity.map((record) => record.tvdbId)),
        }),
      });
      const catalogId = Number(result.lastInsertRowid);
      for (const episode of episodes) {
        insertEpisode.run({
          catalogId,
          season: episode.season,
          episode: episode.episode,
          title: episode.title,
          hasFile: episode.hasFile ? 1 : 0,
          wanted: episode.wanted ? 1 : 0,
          container: episode.container,
          path: episode.path,
          playableLabel: episode.playableLabel,
          qualityName: episode.qualityName,
          resolution: episode.resolution,
          hdr: episode.hdr,
          is3d: episode.is3d ? 1 : 0,
          audioLanguages: JSON.stringify(episode.audioLanguages),
          subtitleLanguages: JSON.stringify(episode.subtitleLanguages),
          subtitleWanted: JSON.stringify(episode.subtitleWanted),
          inPlex: episode.inPlex ? 1 : 0,
          inSonarr: episode.inSonarr ? 1 : 0,
          inBazarr: episode.inBazarr ? 1 : 0,
          airDate: episode.airDate,
        });
      }
    }
  });

  write();
}
