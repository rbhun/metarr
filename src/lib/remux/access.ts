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

function folderModeOwner(directory: string): string {
  try {
    const stat = fs.statSync(/*turbopackIgnore: true*/ directory);
    const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
    return `folder mode ${mode}, uid ${stat.uid}, gid ${stat.gid}`;
  } catch {
    return "folder ownership unknown";
  }
}

export function writeAccessDeniedMessage(directory: string, detail?: string): string {
  const who = `Metarr runs as uid ${process.getuid?.() ?? "unknown"}, gid ${process.getgid?.() ?? "unknown"}`;
  const folder = folderModeOwner(directory);
  const why = detail ? ` (${detail})` : "";
  return (
    `Cannot write next to the disc at ${directory}${why}. ${who}; ${folder}. ` +
    `On the host, either give that user write access to the movie folder, or set METARR_UID/METARR_GID in docker-compose to the owner of /mnt/media and redeploy. ` +
    `The volume must be read-write (not :ro).`
  );
}

/** Fail early when the disc folder cannot receive the MKV. Probes with a real create+delete. */
export function assertWritableDiscFolder(directory: string) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(/*turbopackIgnore: true*/ directory);
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(missingPathMessage(directory));
    throw new Error(`Cannot open ${directory}: ${caught instanceof Error ? caught.message : "access failed."}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${directory} is not a folder, so the remux cannot save an MKV beside the disc.`);
  }
  const probe = path.join(/*turbopackIgnore: true*/ directory, `.metarr-write-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(/*turbopackIgnore: true*/ probe, "ok", { flag: "wx" });
    fs.unlinkSync(/*turbopackIgnore: true*/ probe);
  } catch (caught) {
    try {
      fs.unlinkSync(/*turbopackIgnore: true*/ probe);
    } catch {
      // ignore cleanup
    }
    const code = (caught as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(missingPathMessage(directory));
    throw new Error(writeAccessDeniedMessage(directory, code || (caught instanceof Error ? caught.message : undefined)));
  }
}

export function friendlyFsError(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  const code = (caught as NodeJS.ErrnoException).code;
  const match = /mkdir '(.*)'/.exec(caught.message);
  if (code === "ENOENT" && match?.[1]) return missingPathMessage(path.dirname(match[1]));
  if (code === "ENOENT") return `${caught.message} If Metarr runs in Docker, mount /mnt/media into the container.`;
  if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
    const dirMatch = /'([^']+)'/.exec(caught.message);
    if (dirMatch?.[1]) return writeAccessDeniedMessage(path.dirname(dirMatch[1]), code);
    return writeAccessDeniedMessage("/mnt/media", code);
  }
  return caught.message || fallback;
}
