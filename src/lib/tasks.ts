import type Database from "better-sqlite3";
import { jobTotals as detectTotals, listJobs as listDetectJobs, readDetectPause, type DetectJobStatus, type DetectPause } from "@/lib/detect/store";
import { listMergeJobs, mergeTotals, readMergePause, type MergeJobStatus, type MergePause } from "@/lib/merge/store";
import { outputDirectory } from "@/lib/remux/source";
import { listRemuxJobs, readRemuxPause, remuxTotals, type RemuxJobStatus, type RemuxPause } from "@/lib/remux/store";
import { listRewrapJobs, readRewrapPause, rewrapTotals, type RewrapJobStatus, type RewrapPause } from "@/lib/rewrap/store";
import { titleIdForPath } from "@/lib/title-link";

export type TaskQueue = "language" | "remux" | "rewrap" | "merge";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type TaskStatusFilter = TaskStatus | "all";

export type TaskJob = {
  key: string;
  queue: TaskQueue;
  id: number;
  path: string;
  label: string;
  status: TaskStatus;
  message: string | null;
  priority: "immediate" | "window" | null;
  detail: string;
  progress: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  titleId?: number | null;
  /** Why a pending job is not running yet, as last recorded by its worker. */
  waiting?: string | null;
};

const WAITING: Record<RemuxPause | RewrapPause | DetectPause | MergePause, string> = {
  window: "Waiting for the window",
  plex: "Waiting: Plex is busy",
  detect: "Waiting: language detection is running",
  remux: "Waiting: a disc remux is running",
  rewrap: "Waiting: an MKV rewrap is running",
  merge: "Waiting: a version merge is running",
  off: "Waiting: switched off in Settings",
  write: "Waiting: writing a language into a file",
};

export type TaskTotals = {
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
};

function addTotals(left: TaskTotals, right: { pending: number; running: number; done: number; failed: number; skipped?: number }): TaskTotals {
  return {
    pending: left.pending + right.pending,
    running: left.running + right.running,
    done: left.done + right.done,
    failed: left.failed + right.failed,
    skipped: left.skipped + (right.skipped ?? 0),
  };
}

export function taskTotalsFor(db: Database.Database, queue: TaskQueue | "all"): TaskTotals {
  const language = detectTotals(db);
  const remux = remuxTotals(db);
  const rewrap = rewrapTotals(db);
  const merge = mergeTotals(db);
  if (queue === "language") {
    return { pending: language.pending, running: language.running, done: language.done, failed: language.failed, skipped: language.skipped };
  }
  if (queue === "remux") {
    return { pending: remux.pending, running: remux.running, done: remux.done, failed: remux.failed, skipped: 0 };
  }
  if (queue === "rewrap") {
    return { pending: rewrap.pending, running: rewrap.running, done: rewrap.done, failed: rewrap.failed, skipped: 0 };
  }
  if (queue === "merge") {
    return { pending: merge.pending, running: merge.running, done: merge.done, failed: merge.failed, skipped: 0 };
  }
  return addTotals(addTotals(addTotals({ pending: language.pending, running: language.running, done: language.done, failed: language.failed, skipped: language.skipped }, remux), rewrap), merge);
}

export function taskTotalsSum(totals: TaskTotals): number {
  return totals.pending + totals.running + totals.done + totals.failed + totals.skipped;
}

function stamp(job: TaskJob): number {
  const value = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function statusRank(status: TaskStatus): number {
  if (status === "running") return 0;
  if (status === "pending") return 1;
  return 2;
}

function mapDetect(status: DetectJobStatus | null, page: number, pageSize: number, db: Database.Database): { jobs: TaskJob[]; total: number } {
  const list = listDetectJobs(db, { status, page, pageSize });
  const pause = readDetectPause(db);
  return {
    total: list.total,
    jobs: list.jobs.map((job) => ({
      key: `language:${job.id}`,
      waiting: job.status === "pending" && pause ? WAITING[pause] : null,
      queue: "language" as const,
      id: job.id,
      path: job.path,
      label: job.label,
      status: job.status,
      message: job.message,
      priority: job.priority,
      detail: [job.kind === "audio" ? "Audio" : "Subtitle", job.format, job.placement, `track ${job.ordinal + 1}`, job.streamLabel]
        .filter(Boolean)
        .join(" · "),
      progress: null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    })),
  };
}

function mapRemux(status: RemuxJobStatus | null, page: number, pageSize: number, db: Database.Database): { jobs: TaskJob[]; total: number } {
  const list = listRemuxJobs(db, { status, page, pageSize });
  const pause = readRemuxPause(db);
  return {
    total: list.total,
    jobs: list.jobs.map((job) => ({
      key: `remux:${job.id}`,
      waiting: job.status === "pending" && pause ? WAITING[pause] : null,
      queue: "remux" as const,
      id: job.id,
      path: job.path,
      label: job.label,
      status: job.status,
      message: job.status === "failed" && !job.message ? "Remux failed with no further detail from MakeMKV." : job.message,
      priority: null,
      detail: job.extras ? "Disc remux · longest title and extras" : "Disc remux · longest title only",
      progress: job.progress,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    })),
  };
}

function mapRewrap(status: RewrapJobStatus | null, page: number, pageSize: number, db: Database.Database): { jobs: TaskJob[]; total: number } {
  const list = listRewrapJobs(db, { status, page, pageSize });
  const pause = readRewrapPause(db);
  return {
    total: list.total,
    jobs: list.jobs.map((job) => ({
      key: `rewrap:${job.id}`,
      waiting: job.status === "pending" && pause ? WAITING[pause] : null,
      queue: "rewrap" as const,
      id: job.id,
      path: job.path,
      label: job.label,
      status: job.status,
      message: job.status === "failed" && !job.message ? "Rewrap failed with no further detail from ffmpeg." : job.message,
      priority: null,
      detail: "AVI or M2TS to MKV · no re-encoding",
      progress: job.progress,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    })),
  };
}

function mapMerge(status: MergeJobStatus | null, page: number, pageSize: number, db: Database.Database): { jobs: TaskJob[]; total: number } {
  const list = listMergeJobs(db, { status, page, pageSize });
  const pause = readMergePause(db);
  return {
    total: list.total,
    jobs: list.jobs.map((job) => ({
      key: `merge:${job.id}`,
      waiting: job.status === "pending" && pause ? WAITING[pause] : null,
      queue: "merge" as const,
      id: job.id,
      path: job.videoPath,
      label: job.label,
      status: job.status,
      message: job.status === "failed" && !job.message ? "Version merge failed with no further detail from ffmpeg." : job.message,
      priority: "immediate" as const,
      detail: "Version merge · video from higher quality, all audio and subtitles",
      progress: job.progress,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    })),
  };
}

function mergeJobs(lists: TaskJob[][], status: TaskStatusFilter): TaskJob[] {
  const merged = lists.flat();
  if (status === "pending") return merged.sort((a, b) => a.id - b.id || a.key.localeCompare(b.key));
  if (status === "all") {
    return merged.sort(
      (a, b) => statusRank(a.status) - statusRank(b.status) || stamp(b) - stamp(a) || b.id - a.id || a.key.localeCompare(b.key),
    );
  }
  return merged.sort((a, b) => stamp(b) - stamp(a) || b.id - a.id || a.key.localeCompare(b.key));
}

function withTitles(db: Database.Database, list: { jobs: TaskJob[]; total: number }): { jobs: TaskJob[]; total: number } {
  const found = new Map<string, number | null>();
  const jobs = list.jobs.map((job) => {
    const key = `${job.queue}\0${job.path}`;
    if (!found.has(key)) found.set(key, titleIdForPath(db, job.path, job.queue === "remux" ? outputDirectory(job.path) : null));
    return { ...job, titleId: found.get(key) ?? null };
  });
  return { jobs, total: list.total };
}

/** List language, remux, rewrap, and merge jobs for the Tasks page. */
export function listTaskJobs(
  db: Database.Database,
  query: { queue: TaskQueue | "all"; status: TaskStatusFilter; page: number; pageSize: number },
): { jobs: TaskJob[]; total: number } {
  return withTitles(db, pageOfTaskJobs(db, query));
}

function pageOfTaskJobs(
  db: Database.Database,
  query: { queue: TaskQueue | "all"; status: TaskStatusFilter; page: number; pageSize: number },
): { jobs: TaskJob[]; total: number } {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize) || 50));
  const page = Math.max(1, Math.trunc(query.page) || 1);
  const status = query.status === "all" ? null : query.status;

  if (query.queue === "language") {
    if (status && status !== "pending" && status !== "running" && status !== "done" && status !== "failed" && status !== "skipped") {
      return { jobs: [], total: 0 };
    }
    return mapDetect(status, page, pageSize, db);
  }

  if (query.queue === "remux") {
    if (status === "skipped") return { jobs: [], total: 0 };
    return mapRemux(status, page, pageSize, db);
  }

  if (query.queue === "rewrap") {
    if (status === "skipped") return { jobs: [], total: 0 };
    return mapRewrap(status, page, pageSize, db);
  }

  if (query.queue === "merge") {
    if (status === "skipped") return { jobs: [], total: 0 };
    return mapMerge(status, page, pageSize, db);
  }

  if (status === "skipped") return mapDetect("skipped", page, pageSize, db);

  // Pull enough from each side to page correctly after a merged sort.
  const need = page * pageSize;
  const language = mapDetect(status, 1, need, db);
  const remux = mapRemux(status, 1, need, db);
  const rewrap = mapRewrap(status, 1, need, db);
  const merge = mapMerge(status, 1, need, db);
  const merged = mergeJobs([language.jobs, remux.jobs, rewrap.jobs, merge.jobs], query.status);
  const total = language.total + remux.total + rewrap.total + merge.total;
  const start = (page - 1) * pageSize;
  return { jobs: merged.slice(start, start + pageSize), total };
}
