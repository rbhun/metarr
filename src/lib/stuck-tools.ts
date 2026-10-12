import type { ChildProcess } from "node:child_process";

/** A tool Metarr killed that has not exited. Only a process blocked on file I/O, usually an NFS share that stopped answering, outlives SIGKILL. */
export type StuckTool = {
  id: number;
  command: string;
  file: string | null;
  pid: number | null;
  killedAt: string;
};

export const STUCK_GRACE_MS = 60_000;

const globalForStuck = globalThis as { __metarrStuck?: { next: number; tools: Map<number, StuckTool> } };

function registry() {
  if (!globalForStuck.__metarrStuck) globalForStuck.__metarrStuck = { next: 1, tools: new Map() };
  return globalForStuck.__metarrStuck;
}

/** The media file a tool was working on: the ffmpeg input, else the last absolute path. */
export function toolFile(args: string[]): string | null {
  const input = args.indexOf("-i");
  if (input >= 0 && args[input + 1]?.startsWith("/")) return args[input + 1]!;
  return [...args].reverse().find((arg) => arg.startsWith("/")) ?? null;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

/** Kill a tool that ran past its limit, and list it as stuck if it is still running after the grace period. */
export function killTool(child: ChildProcess, command: string, args: string[], graceMs = STUCK_GRACE_MS): void {
  if (exited(child)) return;
  child.kill("SIGKILL");
  const killedAt = new Date().toISOString();
  let id: number | null = null;
  const timer = setTimeout(() => {
    if (exited(child)) return;
    const store = registry();
    id = store.next++;
    store.tools.set(id, { id, command, file: toolFile(args), pid: child.pid ?? null, killedAt });
    console.error(`${command} (pid ${child.pid ?? "?"}) did not exit after it was killed. It is probably waiting on the NAS.`);
  }, graceMs);
  timer.unref?.();
  child.once("exit", () => {
    clearTimeout(timer);
    if (id != null) registry().tools.delete(id);
  });
}

export function stuckTools(): StuckTool[] {
  return [...registry().tools.values()];
}
