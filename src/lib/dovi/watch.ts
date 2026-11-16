import type Database from "better-sqlite3";
import { parseVersions } from "@/lib/db";
import { doviTarget } from "@/lib/dovi/run";
import { dryRun } from "@/lib/dry-run";
import { enqueueRewraps, readRewrapSettings, type RewrapItem } from "@/lib/rewrap/store";

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}

/** A `.DV7` file is the original kept after a conversion, not a new title to convert again. */
function keptOriginal(filePath: string): boolean {
  return /\.DV7$/i.test(filePath);
}

/**
 * Library files whose video is Dolby Vision 7 and which do not already have a `.DV8.mkv` beside them.
 * Profile 5 is left for a manual convert.
 */
export function profile7Items(db: Database.Database): RewrapItem[] {
  const items: RewrapItem[] = [];
  const seen = new Set<string>();
  const take = (label: string, versionsJson: string | null) => {
    const versions = parseVersions(versionsJson);
    const paths = versions.map((version) => version.path);
    for (const version of versions) {
      if (version.doviProfile !== 7 || !version.path || keptOriginal(version.path)) continue;
      const key = version.path.replace(/\\/g, "/").toLowerCase();
      if (seen.has(key)) continue;
      if (paths.some((item) => item && samePath(item, doviTarget(version.path!)))) continue;
      seen.add(key);
      items.push({ path: version.path, label, mode: "dovi" });
    }
  };
  const movies = db
    .prepare(
      `SELECT title, year, versions_json FROM catalog_titles WHERE kind = 'movie' AND (',' || IFNULL(dovi_profiles, '') || ',') LIKE '%,7,%'`,
    )
    .all() as Array<{ title: string; year: number | null; versions_json: string | null }>;
  for (const row of movies) take(row.year ? `${row.title} (${row.year})` : row.title, row.versions_json);

  const episodes = db
    .prepare(
      `SELECT e.title, e.season, e.episode, e.versions_json, t.title AS series_title
       FROM catalog_episodes e JOIN catalog_titles t ON t.id = e.catalog_id
       WHERE e.versions_json LIKE '%"doviProfile":7%'`,
    )
    .all() as Array<{ title: string; season: number | null; episode: number | null; versions_json: string | null; series_title: string }>;
  for (const row of episodes) {
    const code = row.season == null || row.episode == null ? "Special" : `S${String(row.season).padStart(2, "0")}E${String(row.episode).padStart(2, "0")}`;
    take(`${row.series_title} ${code} ${row.title}`.trim(), row.versions_json);
  }
  return items;
}

/**
 * Queue Dolby Vision 7 files that have never been queued. A finished or failed job stays as it is,
 * so a title is not converted again every time the library is checked. They run in the rewrap hours.
 */
export function queueProfile7(db: Database.Database): number {
  if (dryRun() || !readRewrapSettings(db).doviWatch) return 0;
  const taken = new Set(
    (db.prepare(`SELECT path FROM rewrap_jobs WHERE mode = 'dovi'`).all() as Array<{ path: string }>).map((row) => row.path.replace(/\\/g, "/").toLowerCase()),
  );
  const items = profile7Items(db).filter((item) => !taken.has(item.path.replace(/\\/g, "/").toLowerCase()));
  if (!items.length) return 0;
  return enqueueRewraps(db, items).added;
}
