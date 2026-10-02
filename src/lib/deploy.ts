import fs from "node:fs";
import path from "node:path";
import { VERSION } from "@/lib/version";

/** A request the host watcher has not picked up by then is reported as stuck. */
const STUCK_AFTER_MS = 90_000;
const LOG_TAIL_BYTES = 12_000;

export type DeployRun = {
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  before: string;
  after: string | null;
};

export type DeployState = {
  version: string;
  /** The host watcher is installed, so the Update button can work. */
  available: boolean;
  /** Version published on main, when GitHub could be read. */
  remoteVersion: string | null;
  /** Main is a newer version than this copy. */
  updateAvailable: boolean;
  requestedAt: string | null;
  stuck: boolean;
  run: DeployRun | null;
  log: string;
};

export function deployRunDir(): string {
  return process.env.METARR_RUN_DIR?.trim() || path.join(process.cwd(), "run");
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function tail(file: string, bytes: number): string {
  let handle: number | null = null;
  try {
    handle = fs.openSync(file, "r");
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > bytes ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

export function parseDeployRun(text: string | null): DeployRun | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<DeployRun>;
    if (value.state !== "running" && value.state !== "done" && value.state !== "failed") return null;
    return {
      state: value.state,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
      finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : null,
      exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
      before: typeof value.before === "string" ? value.before : "",
      after: typeof value.after === "string" ? value.after : null,
    };
  } catch {
    return null;
  }
}

/** `1` when `left` is newer, `-1` when it is older. `0.0.10` is newer than `0.0.9`. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string) =>
    value.split(".").map((part) => {
      const number = Number(part);
      return Number.isInteger(number) && number >= 0 ? number : 0;
    });
  const a = parts(left);
  const b = parts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function versionFromSource(text: string): string | null {
  const match = /export const VERSION = "(\d+\.\d+\.\d+)"/.exec(text);
  return match?.[1] ?? null;
}

export function updateIsAvailable(current: string, remote: string | null): boolean {
  return remote != null && compareVersions(remote, current) > 0;
}

const PUBLISHED_VERSION_URL = "https://raw.githubusercontent.com/rbhun/metarr/main/src/lib/version.ts";
const PUBLISHED_CACHE_MS = 15 * 60 * 1000;
const PUBLISHED_RETRY_MS = 60 * 1000;

let publishedCache: { at: number; version: string | null } | null = null;

async function fetchPublishedVersion(): Promise<string | null> {
  try {
    const response = await fetch(PUBLISHED_VERSION_URL, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
    if (!response.ok) return null;
    return versionFromSource(await response.text());
  } catch {
    return null;
  }
}

/** The version on main. A successful read is kept for 15 minutes; a failure is tried again after a minute. */
export async function publishedVersion(now = Date.now()): Promise<string | null> {
  const cached = publishedCache;
  if (cached && now - cached.at < (cached.version ? PUBLISHED_CACHE_MS : PUBLISHED_RETRY_MS)) return cached.version;
  const version = await fetchPublishedVersion();
  if (!version && cached?.version && now - cached.at < PUBLISHED_CACHE_MS) return cached.version;
  publishedCache = { at: now, version };
  return version;
}

export async function deployStatus(directory = deployRunDir(), now = Date.now()): Promise<DeployState> {
  const state = readDeployState(directory, now);
  const remoteVersion = await publishedVersion(now);
  return { ...state, remoteVersion, updateAvailable: updateIsAvailable(state.version, remoteVersion) };
}

export function readDeployState(directory = deployRunDir(), now = Date.now()): DeployState {
  const request = path.join(directory, "deploy-request");
  let requestedAt: string | null = null;
  let stuck = false;
  try {
    const stat = fs.statSync(request);
    requestedAt = stat.mtime.toISOString();
    stuck = now - stat.mtimeMs > STUCK_AFTER_MS;
  } catch {
    requestedAt = null;
  }
  return {
    version: VERSION,
    available: readText(path.join(directory, "watcher")) != null,
    remoteVersion: null,
    updateAvailable: false,
    requestedAt,
    stuck,
    run: parseDeployRun(readText(path.join(directory, "deploy-status.json"))),
    log: tail(path.join(directory, "deploy.log"), LOG_TAIL_BYTES),
  };
}

export type DeployRequest = "requested" | "already" | "unavailable";

/** Leave a request for the host watcher. Metarr itself never runs deploy.sh. */
export function requestDeploy(directory = deployRunDir()): DeployRequest {
  const state = readDeployState(directory);
  if (!state.available) return "unavailable";
  if (state.run?.state === "running" || (state.requestedAt && !state.stuck)) return "already";
  const request = path.join(directory, "deploy-request");
  fs.rmSync(request, { force: true });
  fs.writeFileSync(request, `${new Date().toISOString()}\n`, { flag: "wx", mode: 0o664 });
  return "requested";
}
