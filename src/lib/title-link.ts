import path from "node:path";
import type Database from "better-sqlite3";
import { librarySnapshot } from "@/lib/detect/files";

/**
 * The library title that owns a file, for linking Rips and Tasks to it. Episodes resolve to their series.
 * With `folder`, a lone movie in that folder also counts, so a sidecar or a deleted disc still links.
 */
export function titleIdForPath(db: Database.Database, filePath: string, folder?: string | null): number | null {
  const { paths, folders } = librarySnapshot(db);
  const direct = paths.get(filePath) ?? paths.get(filePath.replace(/\\/g, "/"));
  if (direct) return direct;
  const directory = (folder ?? path.posix.dirname(filePath.replace(/\\/g, "/"))).replace(/\/+$/, "");
  if (!directory || directory === "." || directory === "/") return null;
  return folders.get(directory) ?? null;
}
