import type Database from "better-sqlite3";
import { filesForLibrary } from "@/lib/detect/files";
import { discKind, playableName } from "@/lib/media";
import { discsFromFile } from "@/lib/remux/discs";
import type { PlayableLabel } from "@/lib/types";

export type DiscCandidateView = {
  path: string;
  label: string;
  kind: Exclude<PlayableLabel, "video" | "missing">;
  kindLabel: string;
};

/** Disc images in the library that MakeMKV can remux to MKV. */
export function listDiscCandidates(db: Database.Database): DiscCandidateView[] {
  const seen = new Set<string>();
  const candidates: DiscCandidateView[] = [];
  for (const file of filesForLibrary(db)) {
    for (const disc of discsFromFile(file)) {
      if (seen.has(disc.path)) continue;
      seen.add(disc.path);
      const kind = discKind(null, disc.path) ?? "disc";
      candidates.push({
        path: disc.path,
        label: disc.label,
        kind,
        kindLabel: playableName(kind),
      });
    }
  }
  candidates.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return candidates;
}
