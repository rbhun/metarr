import { fileExtension, splitIdentity } from "@/lib/media";

const AVI = new Set(["avi", "divx"]);
const TRANSPORT = new Set(["m2ts", "mts", "ts"]);

function inDiscFolder(filePath: string): boolean {
  return /[\\/](bdmv|video_ts)[\\/]/i.test(filePath);
}

export function isAvi(container: string | null | undefined, filePath: string | null | undefined): boolean {
  const ext = fileExtension(filePath);
  if (ext) return AVI.has(ext);
  return AVI.has((container ?? "").toLowerCase());
}

/**
 * AVI and loose MPEG transport streams cannot hold a language on each track, so they are copied into an MKV.
 * A transport stream inside a Blu-ray folder belongs to the disc remux instead.
 */
export function canRewrap(container: string | null | undefined, filePath: string | null | undefined): boolean {
  if (isAvi(container, filePath)) return true;
  if (filePath && inDiscFolder(filePath)) return false;
  const ext = fileExtension(filePath) ?? (container ?? "").toLowerCase();
  return TRANSPORT.has(ext);
}

/** "AVI" or "M2TS", for messages about the file being copied. */
export function sourceKind(filePath: string): string {
  const ext = fileExtension(filePath);
  if (!ext || AVI.has(ext)) return "AVI";
  return ext.toUpperCase();
}

/** "avi" or "ts", so a CD1 AVI is not joined with a CD2 transport stream. */
export function rewrapFamily(filePath: string | null | undefined): "avi" | "ts" | null {
  const ext = fileExtension(filePath);
  if (ext && AVI.has(ext)) return "avi";
  if (ext && TRANSPORT.has(ext)) return "ts";
  return null;
}

/** The joined MKV for a labeled split, with the part token removed. `Foo CD1.avi` becomes `Foo.mkv`. */
export function joinedTarget(filePath: string): string | null {
  const split = splitIdentity(filePath);
  if (!split) return null;
  const name = `${split.stem}.mkv`;
  return split.directory ? `${split.directory}/${name}` : name;
}

export type SplitMember = { path: string; index: number; total: number | null };

/** Parts 1..N with no gaps and no two files for the same part. Null when the set is incomplete. */
export function orderedSplit(members: SplitMember[]): SplitMember[] | null {
  if (members.length < 2) return null;
  const byIndex = new Map<number, SplitMember>();
  for (const member of members) {
    if (byIndex.has(member.index)) return null;
    byIndex.set(member.index, member);
  }
  const totals = [...new Set(members.map((member) => member.total).filter((total): total is number => total != null))];
  if (totals.length > 1) return null;
  const expected = totals[0] ?? Math.max(...byIndex.keys());
  if (expected < 2 || expected > 12 || Math.max(...byIndex.keys()) !== expected) return null;
  const ordered: SplitMember[] = [];
  for (let index = 1; index <= expected; index += 1) {
    const member = byIndex.get(index);
    if (!member) return null;
    ordered.push(member);
  }
  return ordered;
}

function joinPath(directory: string, name: string): string {
  if (!directory) return name;
  const separator = directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/g, "")}${separator}${name}`;
}

function directoryOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? filePath.slice(0, slash) : "";
}

/**
 * The complete labeled split that contains this file: CD1 with CD2, or 1 of 3 through 3 of 3.
 * Null when a part is missing or two files claim the same part, so the file is rewrapped alone.
 */
export function splitSources(filePath: string, readDirectory: (directory: string) => string[] | null): string[] | null {
  const self = splitIdentity(filePath);
  const family = rewrapFamily(filePath);
  if (!self || !family) return null;
  const found: SplitMember[] = [];
  const seen = new Set<string>();
  const add = (full: string) => {
    const key = full.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key) || rewrapFamily(full) !== family || !canRewrap(null, full)) return;
    const split = splitIdentity(full);
    if (!split || split.key !== self.key) return;
    seen.add(key);
    found.push({ path: full, index: split.index, total: split.total });
  };
  const walk = (directory: string) => {
    for (const name of readDirectory(directory) ?? []) {
      const child = joinPath(directory, name);
      add(child);
      for (const nested of readDirectory(child) ?? []) add(joinPath(child, nested));
    }
  };
  const own = directoryOf(filePath);
  walk(own);
  // The part token is on the folder (`Movie/CD1/file.avi`), so the other part is a sibling folder.
  const ownKey = own.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
  if (self.directory.replace(/\/+$/g, "").toLowerCase() !== ownKey) {
    const parent = directoryOf(own);
    if (parent !== own) walk(parent);
  }
  const ordered = orderedSplit(found);
  if (!ordered?.some((member) => member.path.replace(/\\/g, "/").toLowerCase() === filePath.replace(/\\/g, "/").toLowerCase())) return null;
  return ordered.map((member) => member.path);
}

/** The MKV lands beside the source under the same name, so sidecar subtitles keep matching. A split set uses joinedTarget instead. */
export function rewrapTarget(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  const stem = dot > slash ? filePath.slice(0, dot) : filePath;
  return `${stem}.mkv`;
}

/** An MKV already sitting on the same title under the rewrap name. */
export function rewrappedPathFor(sourcePath: string, paths: Array<string | null | undefined>): string | null {
  const target = rewrapTarget(sourcePath).toLowerCase();
  return paths.find((item): item is string => Boolean(item) && item!.toLowerCase() === target) ?? null;
}
