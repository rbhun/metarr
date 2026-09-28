import type Database from "better-sqlite3";
import { filesForLibrary } from "@/lib/detect/files";
import { discKind, playableName } from "@/lib/media";
import { convertedFileFor, discsFromFile } from "@/lib/remux/discs";
import type { PlayableLabel } from "@/lib/types";

export { convertedFileFor };

export type DiscCandidateView = {
  path: string;
  label: string;
  kind: Exclude<PlayableLabel, "video" | "missing">;
  kindLabel: string;
  /** Set when the title already has a playable video file, or a real remux of this disc finished. */
  converted: boolean;
  convertedPath: string | null;
  titleId: number | null;
};

function finishedRemuxPaths(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT path FROM remux_jobs WHERE status = 'done' AND (message IS NULL OR message NOT LIKE 'Dry run:%')`)
    .all() as Array<{ path: string }>;
  return new Set(rows.map((row) => row.path));
}

/** Disc images in the library that MakeMKV can remux to MKV. */
export function listDiscCandidates(db: Database.Database): DiscCandidateView[] {
  const seen = new Set<string>();
  const finished = finishedRemuxPaths(db);
  const candidates: DiscCandidateView[] = [];
  for (const file of filesForLibrary(db)) {
    const convertedPath = convertedFileFor(file);
    for (const disc of discsFromFile(file)) {
      if (seen.has(disc.path)) continue;
      seen.add(disc.path);
      const kind = discKind(null, disc.path) ?? "disc";
      candidates.push({
        path: disc.path,
        label: disc.label,
        kind,
        kindLabel: playableName(kind),
        converted: Boolean(convertedPath) || finished.has(disc.path),
        convertedPath,
        titleId: file.titleId ?? null,
      });
    }
  }
  candidates.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return candidates;
}
