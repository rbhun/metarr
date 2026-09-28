import path from "node:path";

/**
 * Where remux and retag work files go. METARR_SCRATCH points at a folder on the NAS
 * outside every library folder; without it, work stays next to the database.
 * Metarr only ever removes its own remux-work/job-N and retag-work/job-* folders inside it.
 */
export function scratchRoot(databasePath: string): string {
  return process.env.METARR_SCRATCH?.trim() || path.dirname(databasePath);
}
