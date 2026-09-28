import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { languageFromProbeTags } from "@/lib/detect/audio";
import { resolveMediaPath, type PathMap } from "@/lib/detect/paths";
import { readDetectSettings } from "@/lib/detect/store";
import { fetchPlexLibraryFolders, type PlexLibraryFolder } from "@/lib/connectors/plex";
import { getMeta, listConnectors, plexExcludedLibraries, saveConnector, setMeta } from "@/lib/db";
import { fileExtension, uniqueLanguages } from "@/lib/media";
import { sourceDraft, withMedia } from "@/lib/source";
import type { AudioTrack, SourceDraft, SubtitleTrack } from "@/lib/types";
import type { ProgressUpdate } from "@/lib/connectors/http";
import type Database from "better-sqlite3";

const ROOTS_KEY = "folder_roots";
const VIDEO = new Set(["mkv", "mp4", "m4v", "avi", "ts", "m2ts", "mts", "mpg", "mpeg", "wmv", "mov", "webm"]);
const SKIP_DIR = new Set([".git", "node_modules", ".metarr-work", "#recycle", "@eadir"]);
const FILE_LIMIT = 20_000;

export type FolderScanSettings = {
  enabled: boolean;
  roots: string[];
};

export function pathKey(filePath: string | null | undefined): string | null {
  const normalized = filePath?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized ? normalized.toLowerCase() : null;
}

export function cleanRoots(values: unknown): string[] {
  const lines = Array.isArray(values) ? values : typeof values === "string" ? values.split(/\r?\n/) : [];
  const roots: string[] = [];
  for (const value of lines) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!path.isAbsolute(trimmed)) throw new Error(`Use a full path: ${trimmed}`);
    roots.push(path.resolve(trimmed));
  }
  return [...new Set(roots)];
}

export function readFolderScan(db: Database.Database): FolderScanSettings {
  const enabled = listConnectors(db).some((connector) => connector.id === "files" && connector.enabled);
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(getMeta(db, ROOTS_KEY) ?? "[]") as unknown;
  } catch {
    parsed = [];
  }
  const roots = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  return { enabled, roots };
}

export function writeFolderScan(db: Database.Database, settings: FolderScanSettings) {
  saveConnector({ id: "files", baseUrl: "", apiKey: "", enabled: settings.enabled }, db);
  setMeta(db, ROOTS_KEY, JSON.stringify(settings.roots));
}

function localizeFolder(folder: string, maps: PathMap[]): string {
  const found = resolveMediaPath(folder, maps, (candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
  return found ?? folder.trim();
}

/** Folders from the Plex libraries Metarr syncs. A path map is applied when that folder exists here. */
export async function suggestedPlexFolders(db: Database.Database): Promise<PlexLibraryFolder[]> {
  const plex = listConnectors(db).find((connector) => connector.id === "plex");
  if (!plex?.baseUrl.trim() || !plex.apiKey.trim()) return [];
  const folders = await fetchPlexLibraryFolders(plex.baseUrl, plex.apiKey, plexExcludedLibraries(db));
  const maps = readDetectSettings(db).pathMaps;
  const seen = new Set<string>();
  const local: PlexLibraryFolder[] = [];
  for (const folder of folders) {
    const folderPath = localizeFolder(folder.path, maps);
    const identity = folderPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    local.push({ path: folderPath, library: folder.library });
  }
  return local;
}

export function tracksFromProbe(payload: unknown): { audio: AudioTrack[]; subtitles: SubtitleTrack[] } | null {
  const record = payload && typeof payload === "object" ? (payload as { streams?: unknown }) : null;
  if (!Array.isArray(record?.streams)) return null;
  const audio: AudioTrack[] = [];
  const subtitles: SubtitleTrack[] = [];
  for (const item of record.streams) {
    if (!item || typeof item !== "object") continue;
    const stream = item as { codec_type?: unknown; codec_name?: unknown; tags?: unknown };
    const language = languageFromProbeTags(stream.tags);
    if (stream.codec_type === "audio") {
      audio.push({ language, layout: null, codec: null, streamIndex: audio.length, fromFile: true });
      continue;
    }
    if (stream.codec_type === "subtitle") {
      subtitles.push({
        language,
        placement: "internal",
        format: subtitleFormat(stream.codec_name),
        forced: false,
        streamIndex: subtitles.length,
        fromFile: true,
      });
    }
  }
  if (!audio.length && !subtitles.length) return null;
  return { audio, subtitles };
}

export function chooseMatch(records: SourceDraft[], filePath: string): SourceDraft | null {
  const key = pathKey(filePath);
  if (!key) return null;
  const hits = records.filter((record) => record.connector !== "files" && recordPaths(record).some((item) => pathKey(item) === key));
  hits.sort((left, right) => matchRank(right) - matchRank(left));
  return hits[0] ?? null;
}

export function folderDraft(filePath: string, probed: { audio: AudioTrack[]; subtitles: SubtitleTrack[] }, match: SourceDraft | null): SourceDraft {
  const base = path.basename(filePath);
  const title = match?.title ?? titleFromName(base);
  const year = match?.year ?? yearInName(base);
  const audioLanguages = uniqueLanguages(probed.audio.map((track) => track.language));
  const subtitleLanguages = uniqueLanguages(probed.subtitles.map((track) => track.language));
  const draft = sourceDraft({
    connector: "files",
    kind: match?.kind === "episode" ? "episode" : "movie",
    externalKey: `path:${pathKey(filePath) ?? filePath}`,
    title,
    seriesTitle: match?.seriesTitle ?? null,
    year,
    season: match?.season ?? null,
    episode: match?.episode ?? null,
    imdbId: match?.imdbId ?? null,
    tmdbId: match?.tmdbId ?? null,
    tvdbId: match?.tvdbId ?? null,
    parentKey: match?.parentKey ?? null,
    hasFile: true,
    path: filePath,
    container: fileExtension(filePath),
  });
  return withMedia(draft, [
    {
      container: fileExtension(filePath),
      path: filePath,
      qualityName: null,
      resolution: null,
      hdr: "none",
      is3d: false,
      audioLanguages,
      subtitleLanguages,
      audioTracks: probed.audio,
      subtitleTracks: probed.subtitles,
    },
  ]);
}

export function listVideos(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    if (found.length > FILE_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length > FILE_LIMIT) return;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIR.has(entry.name.toLowerCase())) continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = fileExtension(full);
      if (ext && VIDEO.has(ext)) found.push(full);
    }
  };
  walk(root);
  if (found.length > FILE_LIMIT) throw new Error("That folder has more than 20,000 video files. Point the scan at the movie or series folders.");
  return found;
}

export async function scanFolders(roots: string[], known: SourceDraft[], onProgress: (update: ProgressUpdate) => void): Promise<SourceDraft[]> {
  const present = roots.filter((root) => fs.existsSync(root));
  const missing = roots.filter((root) => !fs.existsSync(root));
  if (!present.length) throw new Error(`Folder not found: ${missing[0] ?? "the scan folder"}`);
  const files = present.flatMap((root) => listVideos(root));
  const drafts: SourceDraft[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    onProgress({ message: `Files · ${index + 1}/${files.length} ${path.basename(file)}`, fetched: index, total: files.length });
    const probed = tracksFromProbe(await probeFile(file));
    if (!probed) continue;
    drafts.push(folderDraft(file, probed, chooseMatch(known, file)));
  }
  onProgress({
    message: missing.length ? `Scanned ${drafts.length} files. Missing folder: ${missing[0]}` : `Scanned ${drafts.length} files.`,
    fetched: files.length,
    total: files.length,
  });
  return drafts;
}

function recordPaths(record: SourceDraft): string[] {
  const paths = [record.path, ...record.files.map((file) => file.path)];
  return paths.filter((item): item is string => Boolean(item));
}

function matchRank(record: SourceDraft): number {
  return (record.imdbId || record.tmdbId || record.tvdbId ? 2 : 0) + (record.connector === "radarr" || record.connector === "sonarr" ? 1 : 0);
}

function yearInName(name: string): number | null {
  const match = name.match(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/);
  const year = match ? Number(match[1]) : NaN;
  return Number.isFinite(year) ? year : null;
}

function titleFromName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "");
  const text = stem.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return text || stem;
}

function subtitleFormat(codec: unknown): string | null {
  const raw = typeof codec === "string" ? codec.toLowerCase() : "";
  if (!raw) return null;
  if (raw.includes("pgs") || raw.includes("hdmv")) return "PGS";
  if (raw.includes("subrip") || raw === "srt") return "SRT";
  if (raw === "ass" || raw === "ssa") return "ASS";
  if (raw.includes("vob") || raw.includes("dvd")) return "VobSub";
  return raw.toUpperCase();
}

function probeFile(file: string): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_tags=language", "-of", "json", file], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        resolve(null);
      }
    });
  });
}
