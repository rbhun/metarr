import fs from "node:fs";
import os from "node:os";

export type CpuTimes = { idle: number; total: number };

const globalForCpu = globalThis as { __metarrCpu?: CpuTimes };

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** `cpu  user nice system idle iowait irq softirq steal …` from /proc/stat. */
export function timesFromProcStat(text: string): CpuTimes | null {
  const line = text.split("\n").find((entry) => entry.startsWith("cpu "));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number).filter((value) => Number.isFinite(value));
  if (parts.length < 4) return null;
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  return { idle, total: sum(parts) };
}

export function timesFromCpus(cpus: Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTimes | null {
  if (!cpus.length) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

export function cpuPercent(previous: CpuTimes, next: CpuTimes): number | null {
  const total = next.total - previous.total;
  const idle = next.idle - previous.idle;
  if (total <= 0) return null;
  const busy = Math.max(0, Math.min(100, (1 - idle / total) * 100));
  return Math.round(busy);
}

function sampleTimes(): CpuTimes | null {
  try {
    const fromProc = timesFromProcStat(fs.readFileSync("/proc/stat", "utf8"));
    if (fromProc) return fromProc;
  } catch {
    // Windows and some containers have no /proc/stat.
  }
  return timesFromCpus(os.cpus());
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Busy share of the machine this process can see, 0–100. */
export async function readCpuPercent(): Promise<number | null> {
  const next = sampleTimes();
  if (!next) return null;
  const previous = globalForCpu.__metarrCpu;
  globalForCpu.__metarrCpu = next;
  if (!previous) {
    await delay(150);
    const later = sampleTimes();
    if (!later) return null;
    globalForCpu.__metarrCpu = later;
    return cpuPercent(next, later);
  }
  return cpuPercent(previous, next);
}
