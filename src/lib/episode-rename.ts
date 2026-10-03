import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { announceFolder, sonarrSeriesFor } from "@/lib/announce";
import { asRecord, fetchJson, normalizeBaseUrl } from "@/lib/connectors/http";
import { getMeta, listConnectors, queryEpisodes } from "@/lib/db";
import { readDetectSettings } from "@/lib/detect/store";
import { resolveMediaPath } from "@/lib/detect/paths";
import { normalizeTitle } from "@/lib/media";
import { enrichmentKey, matchLocalEpisode, recognizeEpisode, type RecognizedEpisode } from "@/lib/online";
import { titleLanguage } from "@/lib/title-language";
import { rescanTitle } from "@/lib/title-rescan";

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|wmv|mov|m2ts|mts|mpg|mpeg|webm)$/i;

export function fileToken(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
}

export function sonarrEpisodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export function hasSonarrCode(filePath: string, season: number, episode: number): boolean {
  return path.basename(filePath).toUpperCase().includes(sonarrEpisodeCode(season, episode));
}

/** Prefer the English episode title in the file name. Keep the matched title when it is already that English name. */
export function filenameEpisodeTitle(matchedTitle: string, englishTitle: string | null | undefined): string {
  const english = englishTitle?.trim() || "";
  if (!english) return matchedTitle;
  if (normalizeTitle(matchedTitle) === normalizeTitle(english)) return matchedTitle;
  return english;
}

/** `Show - S01E07 - English title.ext`, the shape Sonarr's episode parser accepts. */
export function sonarrEpisodeBasename(seriesTitle: string, season: number, episode: number, episodeTitle: string, extension: string): string {
  const code = sonarrEpisodeCode(season, episode);
  const series = fileToken(seriesTitle) || "Series";
  const title = fileToken(episodeTitle) || "Episode";
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  const prefix = `${series} - ${code} - `;
  const room = Math.max(1, 180 - prefix.length - ext.length);
  return `${prefix}${title.slice(0, room).trim()}${ext}`;
}

export type EpisodeRenamePlan = {
  video: { from: string; to: string };
  sidecars: Array<{ from: string; to: string }>;
};

/** A new name in the same folder, plus sidecars that share the current file stem. */
export function planEpisodeRename(input: {
  filePath: string;
  seriesTitle: string;
  match: { season: number; episode: number; title: string };
  namesInFolder: string[];
}): { plan: EpisodeRenamePlan } | { plan: null; reason: "keep" | "taken" | "skip" } {
  const { match } = input;
  if (match.season == null || match.episode == null || !Number.isInteger(match.season) || !Number.isInteger(match.episode)) return { plan: null, reason: "skip" };
  if (hasSonarrCode(input.filePath, match.season, match.episode)) return { plan: null, reason: "keep" };
  const directory = path.dirname(input.filePath);
  const base = path.basename(input.filePath);
  const extension = path.extname(base);
  const stem = path.basename(base, extension);
  if (!stem || !extension) return { plan: null, reason: "skip" };
  const nextBase = sonarrEpisodeBasename(input.seriesTitle, match.season, match.episode, match.title, extension);
  if (nextBase === base) return { plan: null, reason: "keep" };
  const nextStem = path.basename(nextBase, extension);
  const taken = new Set(input.namesInFolder);
  if (taken.has(nextBase)) return { plan: null, reason: "taken" };
  const sidecars: Array<{ from: string; to: string }> = [];
  for (const name of input.namesInFolder) {
    if (name === base || VIDEO_EXT.test(name)) continue;
    if (!name.toLowerCase().startsWith(stem.toLowerCase())) continue;
    const rest = name.slice(stem.length);
    if (!rest.startsWith(".")) continue;
    const nextName = `${nextStem}${rest}`;
    if (taken.has(nextName)) return { plan: null, reason: "taken" };
    sidecars.push({ from: path.join(directory, name), to: path.join(directory, nextName) });
  }
  return { plan: { video: { from: input.filePath, to: path.join(directory, nextBase) }, sidecars } };
}

export function applyEpisodeRename(plan: EpisodeRenamePlan): void {
  const done: Array<{ from: string; to: string }> = [];
  try {
    for (const file of [plan.video, ...plan.sidecars]) {
      fs.renameSync(file.from, file.to);
      done.push(file);
    }
  } catch (error) {
    for (const file of done.reverse()) {
      try {
        fs.renameSync(file.to, file.from);
      } catch {
        // The original name could not be restored.
      }
    }
    throw error;
  }
}

function parseStoredTitles(raw: unknown): Record<string, Record<string, string>> {
  const container = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!container) return {};
  const titles: Record<string, Record<string, string>> = {};
  for (const [code, value] of Object.entries(container)) {
    const episodes = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    if (!episodes) continue;
    const names: Record<string, string> = {};
    for (const [key, name] of Object.entries(episodes)) {
      if (typeof name === "string" && name.trim() && /^\d+:\d+$/.test(key)) names[key] = name.trim();
    }
    if (Object.keys(names).length) titles[code] = names;
  }
  return titles;
}

function localFile(filePath: string, maps: ReturnType<typeof readDetectSettings>["pathMaps"]): string | null {
  return resolveMediaPath(filePath, maps, (candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

async function postCommand(url: string, headers: Record<string, string>, body: unknown): Promise<number | null> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  return typeof payload?.id === "number" ? payload.id : null;
}

async function waitForCommand(base: string, headers: Record<string, string>, id: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const payload = asRecord(await fetchJson(`${base}/api/v3/command/${id}`, headers, 20_000).catch(() => null));
    const status = typeof payload?.status === "string" ? payload.status : "";
    if (status === "completed") return true;
    if (status === "failed" || status === "aborted") return false;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function askApps(db: Database.Database, folders: string[]): Promise<string> {
  const told = await announceFolder(db, folders);
  const sonarr = listConnectors(db).find((connector) => connector.id === "sonarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  let search = "";
  if (sonarr) {
    try {
      const base = normalizeBaseUrl(sonarr.baseUrl, 8989);
      const headers = { Accept: "application/json", "X-Api-Key": sonarr.apiKey };
      const seriesId = sonarrSeriesFor(asArraySafe(await fetchJson(`${base}/api/v3/series`, headers, 60_000)), folders);
      if (seriesId != null) {
        const command = await postCommand(`${base}/api/v3/command`, headers, { name: "RescanSeries", seriesId });
        const ready = command == null ? false : await waitForCommand(base, headers, command);
        if (ready) {
          await postCommand(`${base}/api/v3/command`, headers, { name: "MissingEpisodeSearch", seriesId });
          search = "Sonarr is searching for episodes that are still missing.";
        } else {
          search = "Sonarr is still rescanning, so the search for missing episodes was left for when that finishes.";
        }
      }
    } catch {
      search = "Sonarr could not be asked to search for missing episodes.";
    }
  }
  const bazarr = listConnectors(db).find((connector) => connector.id === "bazarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (bazarr) {
    try {
      const base = normalizeBaseUrl(bazarr.baseUrl, 6767);
      await fetch(`${base}/api/system/tasks`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Api-Key": bazarr.apiKey },
        body: JSON.stringify({ taskid: "update_episodes" }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // Bazarr learns the episodes from Sonarr on its own schedule.
    }
  }
  return [told, search].filter(Boolean).join(" ");
}

function asArraySafe(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function renameSeriesForSonarr(
  db: Database.Database,
  catalogId: number,
  episodeId?: number | null,
): Promise<{ renamed: number; message: string; catalogId: number | null }> {
  const row = db
    .prepare(`SELECT id, kind, title, year, imdb_id, tmdb_id, tvdb_id, match_key FROM catalog_titles WHERE id = ?`)
    .get(catalogId) as
    | {
        id: number;
        kind: string;
        title: string;
        year: number | null;
        imdb_id: string | null;
        tmdb_id: string | null;
        tvdb_id: string | null;
        match_key: string | null;
      }
    | undefined;
  if (!row) throw new Error("Unknown title.");
  if (row.kind !== "series") throw new Error("Only a series has episode names Sonarr can match.");
  const language = titleLanguage(getMeta(db, "title_language"));
  if (!language) throw new Error("Choose a secondary language in Settings, then look this series up.");
  const matchKey =
    row.match_key ||
    enrichmentKey({
      kind: "series",
      title: row.title,
      year: row.year,
      imdbId: row.imdb_id,
      tmdbId: row.tmdb_id,
      tvdbId: row.tvdb_id,
    });
  const stored = db.prepare(`SELECT episode_titles FROM enrichment WHERE match_key = ?`).get(matchKey) as { episode_titles: string } | undefined;
  let parsed: unknown = null;
  try {
    parsed = stored ? JSON.parse(stored.episode_titles) : null;
  } catch {
    parsed = null;
  }
  const episodeTitles = parseStoredTitles(parsed);
  if (!episodeTitles[language] || Object.keys(episodeTitles[language]).length === 0) {
    throw new Error("Look this series up again so episode titles in the secondary language are stored.");
  }
  const allEpisodes = queryEpisodes(catalogId, db);
  const episodes = allEpisodes.filter((episode) => episodeId == null || episode.id === episodeId);
  const identities: RecognizedEpisode[] = allEpisodes.map((episode) => ({
    season: episode.season,
    episode: episode.episode,
    title: episode.title,
  }));
  const maps = readDetectSettings(db).pathMaps;
  const claimed = new Set<string>();
  let renamed = 0;
  let collisions = 0;
  const folders = new Set<string>();
  for (const episode of episodes) {
    const paths = [episode.path, ...episode.versions.map((version) => version.path)].filter((value): value is string => Boolean(value));
    for (const filePath of paths) {
      const match = recognizeEpisode(filePath, episodeTitles, language, identities);
      if (!match || match.season == null || match.episode == null) continue;
      const localKey = matchLocalEpisode(filePath, episodeTitles[language]);
      const title = filenameEpisodeTitle(match.title, localKey ? episodeTitles.en?.[localKey] : null);
      const local = localFile(filePath, maps);
      if (!local) continue;
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.dirname(local));
      } catch {
        continue;
      }
      const planned = planEpisodeRename({
        filePath: local,
        seriesTitle: row.title,
        match: { season: match.season, episode: match.episode, title },
        namesInFolder: names,
      });
      if (!planned.plan) {
        if (planned.reason === "taken") collisions += 1;
        continue;
      }
      const destination = planned.plan.video.to.toLowerCase();
      if (claimed.has(destination)) {
        collisions += 1;
        continue;
      }
      applyEpisodeRename(planned.plan);
      claimed.add(destination);
      renamed += 1;
      folders.add(path.dirname(local));
    }
  }
  if (renamed === 0) {
    const why = collisions
      ? `${collisions} file${collisions === 1 ? "" : "s"} stayed put because the Sonarr name already exists.`
      : "No file had a secondary-language title that still needs a Sonarr name. A file that already contains the right SxxExx is left as it is.";
    return { renamed: 0, message: why, catalogId };
  }
  const apps = await askApps(db, [...folders]);
  let libraryId: number | null = catalogId;
  try {
    const refreshed = await rescanTitle(db, catalogId, episodeId);
    libraryId = refreshed.catalogId;
  } catch {
    // The files are renamed even if the library row cannot be rebuilt yet.
  }
  const count = renamed === 1 ? "Renamed 1 file" : `Renamed ${renamed} files`;
  const collisionNote = collisions ? ` ${collisions} left in place because the Sonarr name already exists.` : "";
  return {
    renamed,
    catalogId: libraryId,
    message: `${count} to Sonarr names (Show - S01E07 - English title).${collisionNote}${apps ? ` ${apps}` : ""}`,
  };
}
