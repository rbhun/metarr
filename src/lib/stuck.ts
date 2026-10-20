import fs from "node:fs";

/**
 * A tool waiting on the NAS inside the kernel (state D) ignores every signal, SIGKILL included, until
 * the NAS answers. On a hard NFS mount that can be forever. Metarr gives up waiting on such a tool,
 * remembers it, and starts nothing else that touches the media until the process is gone: even an
 * lstat of the file it is writing would hang Metarr itself the same way.
 */
export const STALL_MS = 10 * 60 * 1000;
const CHECK_MS = 30 * 1000;

export type StuckTool = { pid: number; command: string; since: string };
type Entry = StuckTool & { start: string };
export type Sample = { state: string; start: string; io: number | null };

const globalForStuck = globalThis as unknown as { __metarrStuck?: Map<number, Entry> };

function registry(): Map<number, Entry> {
  if (!globalForStuck.__metarrStuck) globalForStuck.__metarrStuck = new Map();
  return globalForStuck.__metarrStuck;
}

/** State letter and start time from /proc/<pid>/stat; the command name may itself hold spaces or parentheses. */
export function parseStat(text: string): { state: string; start: string } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 2).split(" ");
  const state = fields[0];
  const start = fields[19];
  return state && start ? { state, start } : null;
}

/** Bytes read plus written so far, from /proc/<pid>/io. */
export function parseIo(text: string): number | null {
  const read = /^rchar:\s*(\d+)/m.exec(text);
  const write = /^wchar:\s*(\d+)/m.exec(text);
  return read && write ? Number(read[1]) + Number(write[1]) : null;
}

function sample(pid: number): Sample | null {
  try {
    const stat = parseStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (!stat) return null;
    let io: number | null = null;
    try {
      io = parseIo(fs.readFileSync(`/proc/${pid}/io`, "utf8"));
    } catch {
      io = null;
    }
    return { ...stat, io };
  } catch {
    return null;
  }
}

/** Tools Metarr gave up on that are still alive. Entries whose process exited are dropped. */
export function stuckTools(): StuckTool[] {
  const tools: StuckTool[] = [];
  for (const [pid, entry] of registry()) {
    const now = sample(pid);
    if (!now || now.start !== entry.start || now.state === "Z") {
      registry().delete(pid);
      continue;
    }
    tools.push({ pid: entry.pid, command: entry.command, since: entry.since });
  }
  return tools;
}

export function stuckMessage(command: string): string {
  return `${command} has been stuck for ${Math.round(STALL_MS / 60_000)} minutes waiting for the NAS to finish reading or writing a file, and Linux cannot stop it until the NAS answers. The original file was left unchanged. Restart the NFS server on the NAS (on Proxmox: systemctl restart nfs-kernel-server) or reboot this machine; Metarr waits and carries on by itself once the stuck process is gone.`;
}

export function stuckWaiting(tools: StuckTool[]): string {
  const tool = tools[0];
  const at = new Date(tool.since);
  const pad = (value: number) => String(value).padStart(2, "0");
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `Waiting: ${tool.command} is stuck on the NAS since ${when}. Restart the NFS server on the NAS or reboot this machine.`;
}

export class StuckToolError extends Error {}

/**
 * Watch a running tool. When it sits in uninterruptible disk wait with no bytes read or written for
 * STALL_MS, record it as stuck and call `onStuck`. Returns a function that stops watching.
 */
export function watchStall(
  pid: number | undefined,
  command: string,
  onStuck: (error: StuckToolError) => void,
  options: { stallMs?: number; checkMs?: number; read?: (pid: number) => Sample | null } = {},
): () => void {
  const { stallMs = STALL_MS, checkMs = CHECK_MS, read = sample } = options;
  if (!pid || !read(pid)) return () => undefined;
  let lastIo: number | null = null;
  let quietSince = Date.now();
  const timer = setInterval(() => {
    const now = read(pid);
    if (!now) {
      clearInterval(timer);
      return;
    }
    if (now.state !== "D" || now.io !== lastIo) {
      lastIo = now.io;
      quietSince = Date.now();
      return;
    }
    if (Date.now() - quietSince < stallMs) return;
    clearInterval(timer);
    registry().set(pid, { pid, command, since: new Date().toISOString(), start: now.start });
    console.error(`${command} (pid ${pid}) is stuck in uninterruptible disk wait; Metarr stopped waiting for it.`);
    onStuck(new StuckToolError(stuckMessage(command)));
  }, checkMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Remove a scratch folder, unless a stuck tool may still hold a file in it. */
export function removeWorkDir(dir: string) {
  if (stuckTools().length) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
