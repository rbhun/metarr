import fs from "node:fs";
import path from "node:path";

export function partialPath(target: string): string {
  return `${target}.partial`;
}

function leftOver(partial: string): Error {
  return new Error(`${path.basename(partial)} is left over from an earlier copy. Remove it, then try again.`);
}

function writeRefused(directory: string, code: string): Error {
  let detail = "";
  try {
    const stat = fs.statSync(directory);
    const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
    detail = ` Metarr runs as uid ${process.getuid?.() ?? "unknown"}, gid ${process.getgid?.() ?? "unknown"}; folder mode ${mode}, uid ${stat.uid}, gid ${stat.gid}.`;
  } catch {
    detail = "";
  }
  return new Error(`Cannot write in ${directory} (${code}).${detail} The file was left unchanged.`);
}

function isCrossDirectory(code: string | undefined): boolean {
  return code === "EXDEV" || code === "EACCES" || code === "EPERM";
}

/**
 * Move a finished scratch file to `<target>.partial` (a rename on the same filesystem,
 * a copy otherwise), flush it, then rename it to the target, so Plex and the *arr apps
 * never see a half-written file. The scratch file is consumed.
 * Without `replace`, an existing target is never overwritten.
 * Only the `.partial` this call created is ever removed.
 */
export function deliverFile(from: string, target: string, options: { replace?: boolean; mode?: number } = {}) {
  const name = path.basename(target);
  if (!options.replace && fs.existsSync(target)) throw new Error(`${name} already exists, so nothing was written.`);
  const partial = partialPath(target);
  if (fs.existsSync(partial)) throw leftOver(partial);
  let moved = false;
  try {
    fs.renameSync(from, partial);
    moved = true;
  } catch (caught) {
    if (!isCrossDirectory((caught as NodeJS.ErrnoException).code)) throw caught;
  }
  if (!moved) {
    try {
      fs.copyFileSync(from, partial, fs.constants.COPYFILE_EXCL);
    } catch (caught) {
      const code = (caught as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw leftOver(partial);
      fs.rmSync(partial, { force: true });
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw writeRefused(path.dirname(partial), code);
      throw caught;
    }
  }
  try {
    fs.chmodSync(partial, options.mode ?? 0o664);
    const handle = fs.openSync(partial, "r+");
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    if (!options.replace && fs.existsSync(target)) throw new Error(`${name} appeared while copying, so it was left unchanged.`);
    fs.renameSync(partial, target);
  } catch (caught) {
    if (moved) {
      try {
        fs.renameSync(partial, from);
      } catch {
        // Leave the .partial in place rather than lose the finished file.
      }
    } else {
      fs.rmSync(partial, { force: true });
    }
    const code = (caught as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw writeRefused(path.dirname(target), code);
    throw caught;
  }
}
