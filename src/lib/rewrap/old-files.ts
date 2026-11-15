import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { mediaPathCandidates, resolveMediaPath, type PathMap } from "@/lib/detect/paths";
import { readDetectSettings } from "@/lib/detect/store";
import { dryRun } from "@/lib/dry-run";
import { readFolderScan } from "@/lib/folder-scan";
import { joinedTarget, rewrapFamily, rewrapTarget, withoutKeptOriginal } from "@/lib/rewrap/source";

const SKIP_DIR = new Set([".git", "node_modules", ".metarr-work", "#recycle", "@eadir"]);

function existsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function discStream(filePath: string): boolean {
  return /[\\/](bdmv|video_ts)[\\/]/i.test(filePath);
}

/** An AVI or loose transport file whose MKV is already beside it. A subtitle undo copy is not one of these. */
export function supersededByMkv(file: string, exists: (candidate: string) => boolean = existsFile): boolean {
  const plain = withoutKeptOriginal(file);
  const family = rewrapFamily(plain);
  if (family !== "avi" && family !== "ts") return false;
  if (discStream(plain)) return false;
  const mkv = rewrapTarget(plain);
  if (exists(mkv)) return true;
  const joined = joinedTarget(plain);
  return Boolean(joined && exists(joined));
}

/** The source and a `.metarr-orig` copy of it, once the MKV they were copied into exists. */
export function oldCopiesBeside(sources: string[], output: string | null, exists: (candidate: string) => boolean = existsFile): string[] {
  if (!output || !exists(output)) return [];
  const files: string[] = [];
  const seen = new Set<string>();
  for (const file of sources) {
    if (!file) continue;
    const plain = withoutKeptOriginal(file);
    const family = rewrapFamily(plain);
    if (family !== "avi" && family !== "ts") continue;
    if (discStream(plain)) continue;
    for (const candidate of [file, `${plain}.metarr-orig`]) {
      const key = candidate.toLowerCase();
      if (seen.has(key) || key === output.toLowerCase()) continue;
      if (!exists(candidate)) continue;
      seen.add(key);
      files.push(candidate);
    }
  }
  return files;
}

/** Remove those files. A missing file is already gone. */
export function removeOldFiles(files: string[]): string {
  let removed = 0;
  const failed: string[] = [];
  let only = "";
  for (const file of files) {
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.rmSync(file);
      removed += 1;
      only = path.basename(file);
    } catch {
      failed.push(path.basename(file));
    }
  }
  const parts: string[] = [];
  if (removed === 1 && failed.length === 0) parts.push(`Removed the original ${only}.`);
  else if (removed > 0) parts.push(`Removed ${removed} old files.`);
  if (failed.length) parts.push(`Could not remove ${failed.join(", ")}.`);
  return parts.join(" ");
}

function versionPaths(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const filePath = (item as { path?: unknown }).path;
      return typeof filePath === "string" && filePath.trim() ? [filePath] : [];
    });
  } catch {
    return [];
  }
}

function storedPaths(db: Database.Database): string[] {
  const paths: string[] = [];
  const take = (sql: string) => {
    try {
      const rows = db.prepare(sql).all() as Array<{ path?: string | null; versions_json?: string | null }>;
      for (const row of rows) {
        if (row.path?.trim()) paths.push(row.path);
        paths.push(...versionPaths(row.versions_json));
      }
    } catch {
      // An older database can be missing a table this scan reads.
    }
  };
  take(`SELECT path, versions_json FROM catalog_titles`);
  take(`SELECT path, versions_json FROM catalog_episodes`);
  take(`SELECT path FROM source_records`);
  take(`SELECT path FROM rewrap_jobs`);
  return paths;
}

function localDirectory(filePath: string, maps: PathMap[]): string | null {
  const file = resolveMediaPath(filePath, maps, existsFile);
  if (file) return path.dirname(file);
  for (const candidate of mediaPathCandidates(filePath, maps)) {
    const directory = path.dirname(candidate);
    try {
      if (fs.statSync(directory).isDirectory()) return directory;
    } catch {
      // Try the next path mapping.
    }
  }
  return null;
}

function scanDirectory(directory: string, found: Map<string, string>) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const full = path.join(directory, entry.name);
    if (!supersededByMkv(full)) continue;
    found.set(full.toLowerCase(), full);
  }
}

function walk(directory: string, found: Map<string, string>, depth: number, maxDepth: number) {
  scanDirectory(directory, found);
  if (depth >= maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIP_DIR.has(entry.name.toLowerCase())) continue;
    walk(path.join(directory, entry.name), found, depth + 1, maxDepth);
  }
}

function underRoot(directory: string, roots: string[]): boolean {
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return roots.some((root) => {
    const base = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return normalized === base || normalized.startsWith(`${base}/`);
  });
}

export function findOldFiles(db: Database.Database): string[] {
  const maps = readDetectSettings(db).pathMaps;
  const roots = readFolderScan(db).roots;
  const found = new Map<string, string>();
  for (const root of roots) walk(root, found, 0, 12);
  for (const filePath of storedPaths(db)) {
    const directory = localDirectory(filePath, maps);
    if (!directory || underRoot(directory, roots)) continue;
    walk(directory, found, 0, 2);
  }
  return [...found.values()];
}

/** Delete every original that already has its MKV. The MKV and subtitle undo copies stay. */
export function deleteAllOldFiles(db: Database.Database): { removed: number; failed: number; folders: string[] } {
  if (dryRun()) throw new Error("Dry run is on, so nothing was deleted.");
  const folders = new Set<string>();
  let removed = 0;
  let failed = 0;
  for (const file of findOldFiles(db)) {
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.rmSync(file);
      removed += 1;
      folders.add(path.dirname(file));
    } catch {
      failed += 1;
    }
  }
  return { removed, failed, folders: [...folders] };
}
