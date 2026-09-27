import fs from "node:fs";
import path from "node:path";

/** Temp folder for MakeMKV output, under the database directory so Docker always can write. */
export function remuxWorkDirectory(databasePath: string, jobId: number): string {
  return path.join(path.dirname(databasePath), "remux-work", `job-${jobId}`);
}

/** Explain a missing path for Tasks, including the Docker volume case. */
export function missingPathMessage(target: string): string {
  const resolved = path.resolve(target);
  const parts = resolved.split(path.sep).filter(Boolean);
  let current: string = path.sep;
  for (const part of parts) {
    const next = path.join(/*turbopackIgnore: true*/ current, part);
    try {
      fs.statSync(/*turbopackIgnore: true*/ next);
    } catch (caught) {
      const code = (caught as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return (
          `Cannot write next to the disc: ${next} is missing inside Metarr. ` +
          `If Metarr runs in Docker, mount the host media folder (for example /mnt/media) into the container at the same path, then redeploy.`
        );
      }
      return `Cannot open ${next}: ${caught instanceof Error ? caught.message : "access failed."}`;
    }
    current = next;
  }
  return `Cannot write next to the disc at ${resolved}.`;
}

/** Fail early when the disc folder cannot receive the MKV. */
export function assertWritableDiscFolder(directory: string) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(missingPathMessage(directory));
    throw new Error(`Cannot open ${directory}: ${caught instanceof Error ? caught.message : "access failed."}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${directory} is not a folder, so the remux cannot save an MKV beside the disc.`);
  }
  try {
    fs.accessSync(directory, fs.constants.W_OK);
  } catch {
    throw new Error(
      `Cannot write next to the disc at ${directory}. Metarr needs write access there (Docker volume must not be :ro).`,
    );
  }
}

export function friendlyFsError(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  const code = (caught as NodeJS.ErrnoException).code;
  const match = /mkdir '(.*)'/.exec(caught.message);
  if (code === "ENOENT" && match?.[1]) return missingPathMessage(path.dirname(match[1]));
  if (code === "ENOENT") return `${caught.message} If Metarr runs in Docker, mount /mnt/media into the container.`;
  if (code === "EACCES" || code === "EROFS") {
    return `${caught.message} Metarr needs write access beside the disc (check the Docker volume is not read-only).`;
  }
  return caught.message || fallback;
}
