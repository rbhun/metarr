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
 * Relative path from /proc/self/cgroup. Unified v2 (`0::/…`) wins over a v1
 * cpu/cpuacct line. Empty means this process's cgroup is the mount root.
 */
export function cgroupRelPath(text: string): string | null {
  let fromCpu: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const id = line.slice(0, first);
    const controllers = line.slice(first + 1, second);
    const path = line.slice(second + 1) || "/";
    if (id === "0" && controllers === "") return path;
    const names = controllers.split(",");
    if (names.includes("cpu") || names.includes("cpuacct")) fromCpu = path;
  }
  return fromCpu;
}

/** Join a cgroup relative path onto a controller mount. `/` is the mount root. */
export function cgroupJoin(rel: string, file: string, mount = "/sys/fs/cgroup"): string {
  const trimmed = rel.replace(/\/+$/, "");
  const nested = trimmed ? (trimmed.startsWith("/") ? trimmed : `/${trimmed}`) : "";
  return `${mount}${nested}/${file}`;
}

export function cgroupStatPaths(rel: string): string[] {
  return [
    cgroupJoin(rel, "cpu.stat"),
    cgroupJoin(rel, "cpuacct.usage", "/sys/fs/cgroup/cpuacct"),
    cgroupJoin(rel, "cpuacct.usage", "/sys/fs/cgroup/cpu,cpuacct"),
    cgroupJoin(rel, "cpuacct.usage", "/sys/fs/cgroup/cpu"),
  ];
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

function readFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function thisCgroupRel(): string | null {
  const text = readFile("/proc/self/cgroup");
  return text ? cgroupRelPath(text) : null;
}

function sampleCgroup(atMs = Date.now()): CgroupSample | null {
  const rel = thisCgroupRel();
  if (!rel) return null;
  for (const path of cgroupStatPaths(rel)) {
    const text = readFile(path);
    if (!text) continue;
    const usageUs = path.endsWith("cpu.stat") ? usageFromCpuStat(text) : usageFromCpuacct(text);
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

/** Host is the whole VM. Docker is this process's cgroup share of the same machine. */
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
