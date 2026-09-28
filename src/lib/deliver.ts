import fs from "node:fs";
import path from "node:path";

export function partialPath(target: string): string {
  return `${target}.partial`;
}

/**
 * Copy a finished file from local scratch to `<target>.partial`, flush it, then
 * rename it to the target, so Plex and the *arr apps never see a half-written file.
 * Without `replace`, an existing target is never overwritten.
 * Only the `.partial` this call created is ever removed.
 */
export function deliverFile(from: string, target: string, options: { replace?: boolean; mode?: number } = {}) {
  const name = path.basename(target);
  if (!options.replace && fs.existsSync(target)) throw new Error(`${name} already exists, so nothing was written.`);
  const partial = partialPath(target);
  try {
    fs.copyFileSync(from, partial, fs.constants.COPYFILE_EXCL);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${path.basename(partial)} is left over from an earlier copy. Remove it, then try again.`);
    }
    fs.rmSync(partial, { force: true });
    throw caught;
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
    fs.rmSync(partial, { force: true });
    throw caught;
  }
}
