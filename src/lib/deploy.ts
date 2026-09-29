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
