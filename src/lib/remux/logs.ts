import fs from "node:fs";
import path from "node:path";

const KEEP = 30;
const TAIL = 8_000_000;
const FILES = ["disc.txt", "info-output.txt", "info-debug.txt", "mkv-output.txt", "mkv-debug.txt"];

/** Always under the app data folder, never on the media drive. */
function logRoot(dbName: string) {
  return path.join(path.dirname(dbName), "makemkv-logs");
}

export function makemkvLogDir(dbName: string, jobId: number) {
  return path.join(logRoot(dbName), `job-${jobId}`);
}

/** A fresh folder for this run; older job folders beyond the last 30 are removed. */
export function prepareMakemkvLogDir(dbName: string, jobId: number): string | undefined {
  try {
    const root = logRoot(dbName);
    const dir = makemkvLogDir(dbName, jobId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const old = fs
      .readdirSync(root)
      .map((name) => ({ name, id: Number(/^job-(\d+)$/.exec(name)?.[1]) }))
      .filter((entry) => Number.isInteger(entry.id) && entry.id > 0)
      .sort((a, b) => b.id - a.id)
      .slice(KEEP);
    for (const entry of old) fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    return dir;
  } catch {
    return undefined;
  }
}

function tail(text: string) {
  return text.length > TAIL ? `…(start cut)\n${text.slice(-TAIL)}` : text;
}

/** Everything MakeMKV wrote for one job, as plain text, or null when nothing was saved. */
export function readMakemkvLog(dbName: string, jobId: number): string | null {
  const dir = makemkvLogDir(dbName, jobId);
  const parts: string[] = [];
  for (const name of FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    parts.push(`===== ${name} =====\n${tail(fs.readFileSync(file, "utf8"))}`);
  }
  return parts.length ? parts.join("\n\n") : null;
}
