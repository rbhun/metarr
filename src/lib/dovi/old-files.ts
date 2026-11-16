import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { mediaPathCandidates, resolveMediaPath, type PathMap } from "@/lib/detect/paths";
import { readDetectSettings } from "@/lib/detect/store";
import { doviFinalName } from "@/lib/dovi/run";
import { dryRun } from "@/lib/dry-run";
import { readFolderScan } from "@/lib/folder-scan";

const SKIP_DIR = new Set([".git", "node_modules", ".metarr-work", "#recycle", "@eadir"]);

function existsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** A `.DV7` original whose converted movie is already beside it under the original name. */
export function leftoverDoviOriginal(file: string, exists: (candidate: string) => boolean = existsFile): boolean {
  if (!/\.DV7$/i.test(path.basename(file))) return false;
  const final = doviFinalName(file);
  if (final.replace(/\\/g, "/").toLowerCase() === file.replace(/\\/g, "/").toLowerCase()) return false;
  return exists(final);
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
    if (!leftoverDoviOriginal(full)) continue;
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

export function findDoviOriginals(db: Database.Database): string[] {
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

/** Delete every `.DV7` original that already has its Dolby Vision 8 movie. The movie stays. */
export function deleteDoviOriginals(db: Database.Database): { removed: number; failed: number; folders: string[] } {
  if (dryRun()) throw new Error("Dry run is on, so nothing was deleted.");
  const folders = new Set<string>();
  let removed = 0;
  let failed = 0;
  for (const file of findDoviOriginals(db)) {
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
