import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getMeta, loadSourceRecords, setMeta } from "@/lib/db";
import type { SourceDraft } from "@/lib/types";

/** Who Plex runs as. An empty id means Plex is neither the owner nor in the file's group, so only the permissions for everyone else count. */
export type PlexAccount = { uid: number | null; gids: number[] };

export type AccessStat = { uid: number; gid: number; mode: number; directory: boolean };

export const PLEX_UNREADABLE_KEY = "plex_unreadable";
export const FOLDER_MASK_REPAIR_KEY = "folder_mask_repair";
export const FOLDER_MASK_OPENED_KEY = "folder_mask_opened";
/** Set after the paths already stored on titles have been checked. */
export const FOLDER_MASK_KNOWN_KEY = "folder_mask_known";

const VIDEO = new Set(["mkv", "mp4", "m4v", "avi", "ts", "m2ts", "mts", "mpg", "mpeg", "wmv", "mov", "webm"]);
const SKIP_DIR = new Set([".git", "node_modules", ".metarr-work", "#recycle", "@eadir"]);

export function readPlexAccount(): PlexAccount {
  return { uid: parseId(process.env.PLEX_UID), gids: gidsOf(process.env.PLEX_GID) };
}

function parseId(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function gidsOf(value: string | undefined): number[] {
  const gid = parseId(value);
  return gid == null ? [] : [gid];
}

/** Read, or enter a directory. Owner, then group, then everyone else. */
export function canAccess(stat: AccessStat, account: PlexAccount, bit: number): boolean {
  const mode = stat.mode & 0o777;
  if (account.uid != null && stat.uid === account.uid) return (mode & (bit << 6)) !== 0;
  if (account.gids.includes(stat.gid)) return (mode & (bit << 3)) !== 0;
  return (mode & bit) !== 0;
}

/** Plex has to list the folder and step into it. */
export function directoryOpenTo(stat: AccessStat, account: PlexAccount): boolean {
  return canAccess(stat, account, 0o4) && canAccess(stat, account, 0o1);
}

export function fileReadableBy(stat: AccessStat, account: PlexAccount): boolean {
  return canAccess(stat, account, 0o4);
}

export function loadUnreadable(db: Database.Database): string[] {
  try {
    const parsed = JSON.parse(getMeta(db, PLEX_UNREADABLE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

export function saveUnreadable(db: Database.Database, paths: Iterable<string>) {
  const unique = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  setMeta(db, PLEX_UNREADABLE_KEY, JSON.stringify(unique));
}

/** File and folder paths Metarr already stored from Plex, Radarr, Sonarr, Bazarr, or a folder scan. */
export function pathsOnTitles(records: SourceDraft[]): string[] {
  const paths: string[] = [];
  for (const record of records) {
    if (record.path) paths.push(record.path);
    for (const file of record.files) {
      if (file.path) paths.push(file.path);
    }
  }
  return paths;
}

function stillClosed(filePath: string, account: PlexAccount): boolean {
  const info = readStat(filePath);
  if (info == null) return false;
  if (info === "denied") return true;
  return info.directory ? !directoryOpenTo(info, account) : !fileReadableBy(info, account);
}

/**
 * Folders and videos in `paths` that Plex cannot open.
 * A path that does not exist on this machine is skipped.
 */
export function closedAmong(paths: Iterable<string>, account: PlexAccount): { closed: string[]; sawDisk: boolean } {
  const blocked = new Set<string>();
  const parents = new Set<string>();
  const files: string[] = [];
  let sawDisk = false;
  for (const raw of paths) {
    const filePath = normalized(raw);
    if (!filePath) continue;
    const info = readStat(filePath);
    if (info === "denied") sawDisk = true;
    if (info == null || info === "denied") {
      if (info === "denied") {
        parents.add(path.dirname(filePath));
        files.push(filePath);
      }
      continue;
    }
    sawDisk = true;
    if (info.directory) {
      parents.add(filePath);
      continue;
    }
    parents.add(path.dirname(filePath));
    files.push(filePath);
  }
  for (const parent of parents) markClosed(parent, "directory", account, blocked);
  for (const file of files) markClosed(file, "file", account, blocked);
  return { closed: [...blocked], sawDisk };
}

/** Directories above a file that Plex cannot open, stopping at the first folder this machine can see. */
function closedChain(filePath: string, account: PlexAccount): string[] {
  const closed: string[] = [];
  let current = normalized(filePath);
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const info = readStat(current);
    if (info && info !== "denied") {
      const open = info.directory ? directoryOpenTo(info, account) : fileReadableBy(info, account);
      if (!open) closed.push(current);
      if (info.directory) break;
    }
    const parent = path.dirname(current);
    if (parent === current || parent === "/" || parent === ".") break;
    current = parent;
  }
  return closed;
}

/**
 * Open the folders for one title's files, then check those paths again.
 * Other titles' closed folders stay on the list.
 */
export function repairTitlePaths(db: Database.Database, targets: string[]): { opened: string[]; failed: MaskFailure[]; remaining: string[] } {
  const account = readPlexAccount();
  const files = [...new Set(targets.map((item) => normalized(item)).filter(Boolean))];
  const closed = new Set<string>();
  for (const filePath of files) for (const item of closedChain(filePath, account)) closed.add(item);
  const opened: string[] = [];
  const failed: MaskFailure[] = [];
  for (const item of [...closed].sort((left, right) => left.length - right.length)) {
    const result = repairClosed(item, account);
    opened.push(...result.opened);
    failed.push(...result.failed);
  }
  const remaining = new Set<string>();
  for (const filePath of files) for (const item of closedChain(filePath, account)) remaining.add(item);
  const blocked = new Set(loadUnreadable(db));
  for (const prior of [...blocked]) {
    const touches = files.some((filePath) => pathInside(filePath, prior) || pathInside(prior, filePath));
    if (touches && !stillClosed(prior, account)) blocked.delete(prior);
  }
  for (const item of remaining) blocked.add(item);
  saveUnreadable(db, blocked);
  return { opened, failed, remaining: [...remaining] };
}

/**
 * Check the paths already stored on titles and remember the ones Plex cannot open.
 * When `repair` is set, a closed path is opened for everyone else and then checked again.
 * Returns updated: false when none of the paths exist on this machine, leaving the stored list as it is.
 */
export function refreshClosedTitles(db: Database.Database, repair: boolean): { updated: boolean; opened: string[] } {
  const account = readPlexAccount();
  const known = pathsOnTitles(loadSourceRecords(db));
  let found = closedAmong(known, account);
  if (!found.sawDisk && known.length > 0) return { updated: false, opened: [] };
  const opened: string[] = [];
  if (repair && found.closed.length > 0) {
    const ordered = [...found.closed].sort((left, right) => left.length - right.length);
    for (const item of ordered) {
      const result = repairClosed(item, account);
      opened.push(...result.opened);
    }
    found = closedAmong(known, account);
  }
  const blocked = new Set(found.closed);
  for (const prior of loadUnreadable(db)) {
    if (blocked.has(prior) || coveredBy(prior, blocked)) continue;
    if (stillClosed(prior, account)) blocked.add(prior);
  }
  saveUnreadable(db, blocked);
  setMeta(db, FOLDER_MASK_KNOWN_KEY, "1");
  return { updated: true, opened };
}

function normalized(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function pathInside(filePath: string, folder: string): boolean {
  const file = normalized(filePath);
  const base = normalized(folder);
  return file === base || file.startsWith(`${base}/`);
}

export function coveredBy(filePath: string, blocked: Iterable<string>): boolean {
  for (const folder of blocked) {
    if (normalized(folder) !== normalized(filePath) && pathInside(filePath, folder)) return true;
  }
  return false;
}

/** One line for a title whose file or folder is in the blocked list. */
export function noteForBlocks(paths: Array<string | null | undefined>, blocked: string[]): string | null {
  const names = new Set<string>();
  for (const filePath of paths) {
    if (!filePath) continue;
    for (const folder of blocked) {
      if (pathInside(filePath, folder)) names.add(normalized(folder).split("/").pop() || folder);
    }
  }
  if (names.size === 0) return null;
  if (names.size === 1) return `Plex cannot read ${[...names][0]}.`;
  return `Plex cannot read ${names.size} folders.`;
}

export function isDirectory(filePath: string): boolean {
  const info = readStat(filePath);
  return info != null && info !== "denied" && info.directory;
}

export function readStat(filePath: string): AccessStat | "denied" | null {
  try {
    const stat = fs.statSync(filePath);
    return { uid: stat.uid, gid: stat.gid, mode: stat.mode, directory: stat.isDirectory() };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EACCES" || code === "EPERM") return "denied";
    return null;
  }
}

/** Missing means on. The folder scan opens a closed folder unless this is set to "0". */
export function maskRepairEnabled(db: Database.Database): boolean {
  return getMeta(db, FOLDER_MASK_REPAIR_KEY) !== "0";
}

export function writeMaskRepair(db: Database.Database, enabled: boolean) {
  setMeta(db, FOLDER_MASK_REPAIR_KEY, enabled ? "1" : "0");
}

/** Keep the owner, group, and setgid bit. Add read, plus enter on a folder, for everyone else. */
export function correctedMode(mode: number, kind: "directory" | "file"): number {
  return (mode & 0o7777) | (kind === "directory" ? 0o005 : 0o004);
}

export type MaskFailure = { path: string; error: string };

function ioMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code === "EROFS") return "Read-only file system";
  if (code === "EPERM" || code === "EACCES") return "Permission denied";
  return error instanceof Error ? error.message : "Could not change permissions";
}

function videoFile(name: string): boolean {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return VIDEO.has(ext);
}

/**
 * Open one closed folder or video for everyone else, then the videos and folders inside it.
 * A path that is already open is left as it is.
 */
export function repairClosed(filePath: string, account: PlexAccount): { opened: string[]; failed: MaskFailure[] } {
  const opened: string[] = [];
  const failed: MaskFailure[] = [];
  const visit = (target: string, kind: "directory" | "file") => {
    const info = readStat(target);
    if (info == null) return;
    if (info === "denied") {
      failed.push({ path: target, error: "Permission denied" });
      return;
    }
    const open = kind === "directory" ? directoryOpenTo(info, account) : fileReadableBy(info, account);
    if (!open) {
      try {
        fs.chmodSync(target, correctedMode(info.mode, kind));
        opened.push(target);
      } catch (error) {
        failed.push({ path: target, error: ioMessage(error) });
        return;
      }
    }
    if (kind !== "directory") return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (error) {
      failed.push({ path: target, error: ioMessage(error) });
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIR.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) visit(full, "directory");
      else if (entry.isFile() && videoFile(entry.name)) visit(full, "file");
    }
  };
  const info = readStat(filePath);
  visit(filePath, info && info !== "denied" && info.directory ? "directory" : "file");
  return { opened, failed };
}

/** Remember a folder or file Plex cannot open. A path already inside a blocked folder is left out. */
export function markClosed(filePath: string, kind: "directory" | "file", account: PlexAccount, blocked: Set<string>) {
  if (coveredBy(filePath, blocked)) return;
  const info = readStat(filePath);
  const closed = info === "denied" || (info != null && (kind === "directory" ? !directoryOpenTo(info, account) : !fileReadableBy(info, account)));
  if (closed) blocked.add(filePath);
}
