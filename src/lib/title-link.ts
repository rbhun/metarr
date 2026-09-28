import path from "node:path";
import type Database from "better-sqlite3";

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Matches a path stored in versions_json, whatever spacing the JSON has. */
function versionsPattern(filePath: string): string {
  return `%${likeEscape(JSON.stringify(filePath))}%`;
}

/**
 * The library title that owns a file, for linking Rips and Tasks to it. Episodes resolve to their series.
 * With `folder`, a lone movie in that folder also counts, so a sidecar or a deleted disc still links.
 */
export function titleIdForPath(db: Database.Database, filePath: string, folder?: string | null): number | null {
  const pattern = versionsPattern(filePath);
  const title = db
    .prepare(`SELECT id FROM catalog_titles WHERE path = ? OR versions_json LIKE ? ESCAPE '\\' LIMIT 1`)
    .get(filePath, pattern) as { id: number } | undefined;
  if (title) return title.id;
  const episode = db
    .prepare(`SELECT catalog_id FROM catalog_episodes WHERE path = ? OR versions_json LIKE ? ESCAPE '\\' LIMIT 1`)
    .get(filePath, pattern) as { catalog_id: number } | undefined;
  if (episode) return episode.catalog_id;
  const directory = (folder ?? path.posix.dirname(filePath.replace(/\\/g, "/"))).replace(/\/+$/, "");
  if (!directory || directory === "." || directory === "/") return null;
  const movies = db
    .prepare(`SELECT id FROM catalog_titles WHERE kind = 'movie' AND path LIKE ? ESCAPE '\\' LIMIT 2`)
    .all(`${likeEscape(directory)}/%`) as Array<{ id: number }>;
  return movies.length === 1 ? movies[0]!.id : null;
}
