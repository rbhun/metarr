import fs from "node:fs";
import os from "node:os";

export type CpuTimes = { idle: number; total: number };
export type CgroupSample = { usageUs: number; atMs: number };
export type CpuReading = { host: number | null; docker: number | null };

const globalForCpu = globalThis as { __metarrCpu?: CpuTimes; __metarrCgroup?: CgroupSample };

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

/** cgroup v2 `cpu.stat`: usage_usec is this container's CPU time in microseconds. */
export function usageFromCpuStat(text: string): number | null {
  const line = text.split("\n").find((entry) => entry.startsWith("usage_usec "));
  if (!line) return null;
  const value = Number(line.slice("usage_usec ".length).trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** cgroup v1 `cpuacct.usage` is nanoseconds. */
export function usageFromCpuacct(text: string): number | null {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value / 1000);
}

/**
 * This container's share of the whole machine, 0–100. 25 on a 4-core box is one
 * core busy inside the container.
 */
export function dockerPercent(previous: CgroupSample, next: CgroupSample, ncpus: number): number | null {
  const elapsedUs = (next.atMs - previous.atMs) * 1000;
  const used = next.usageUs - previous.usageUs;
  if (elapsedUs <= 0 || ncpus <= 0 || used < 0) return null;
  return Math.round(Math.max(0, Math.min(100, (used / (elapsedUs * ncpus)) * 100)));
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

const CGROUP_STAT = ["/sys/fs/cgroup/cpu.stat"];
const CGROUP_ACCT = ["/sys/fs/cgroup/cpuacct.usage", "/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage", "/sys/fs/cgroup/cpuacct/cpuacct.usage"];

function readFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function sampleCgroup(atMs = Date.now()): CgroupSample | null {
  for (const path of CGROUP_STAT) {
    const text = readFile(path);
    const usageUs = text ? usageFromCpuStat(text) : null;
    if (usageUs != null) return { usageUs, atMs };
  }
  for (const path of CGROUP_ACCT) {
    const text = readFile(path);
    const usageUs = text ? usageFromCpuacct(text) : null;
    if (usageUs != null) return { usageUs, atMs };
  }
  return null;
}

function cpuCount(): number {
  const count = os.availableParallelism?.() ?? os.cpus().length;
  return count > 0 ? count : 1;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostFrom(previous: CpuTimes | undefined, next: CpuTimes | null): { host: number | null; stored: CpuTimes | undefined } {
  if (!next) return { host: null, stored: previous };
  const host = previous ? cpuPercent(previous, next) : null;
  return { host, stored: next };
}

function dockerFrom(previous: CgroupSample | undefined, next: CgroupSample | null): { docker: number | null; stored: CgroupSample | undefined } {
  if (!next) return { docker: null, stored: previous };
  const docker = previous ? dockerPercent(previous, next, cpuCount()) : null;
  return { docker, stored: next };
}

/** Host is the whole VM. Docker is this container's share of the same machine. */
export async function readCpu(): Promise<CpuReading> {
  let hostPrev = globalForCpu.__metarrCpu;
  let dockerPrev = globalForCpu.__metarrCgroup;
  let hostNext = sampleTimes();
  let dockerNext = sampleCgroup();
  if (!hostPrev || (dockerNext && !dockerPrev)) {
    await delay(150);
    if (!hostPrev) hostPrev = hostNext ?? undefined;
    if (!dockerPrev) dockerPrev = dockerNext ?? undefined;
    hostNext = sampleTimes() ?? hostNext;
    dockerNext = sampleCgroup() ?? dockerNext;
  }
  const host = hostFrom(hostPrev, hostNext);
  const docker = dockerFrom(dockerPrev, dockerNext);
  globalForCpu.__metarrCpu = host.stored;
  globalForCpu.__metarrCgroup = docker.stored;
  return { host: host.host, docker: docker.docker };
}
