import type Database from "better-sqlite3";
import { filesForLibrary, filesForSelection } from "@/lib/detect/files";
import { enqueueTargets, retryAllFailedJobs, type DetectPriority } from "@/lib/detect/store";
import { targetsFromFiles, type DetectTarget } from "@/lib/detect/targets";

export function queueDetection(
  db: Database.Database,
  input: { tracks: DetectTarget[]; titles: number[]; episodes: number[]; all: boolean },
  priority: DetectPriority,
): { added: number; already: number } {
  const retried = input.all ? retryAllFailedJobs(db) : 0;
  const files = input.all ? filesForLibrary(db) : filesForSelection(db, input.titles, input.episodes);
  const targets = input.tracks.length ? input.tracks : targetsFromFiles(files, true, new Set());
  const queued = enqueueTargets(db, targets, priority);
  if (!retried) return queued;
  return { added: queued.added + retried, already: queued.already };
}
