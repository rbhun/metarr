import type Database from "better-sqlite3";
import { jobTotals as detectTotals, listJobs as listDetectJobs, type DetectJobStatus } from "@/lib/detect/store";
import { listRemuxJobs, remuxTotals, type RemuxJobStatus } from "@/lib/remux/store";

export type TaskQueue = "language" | "remux";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

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
  if (queue === "language") {
    return { pending: language.pending, running: language.running, done: language.done, failed: language.failed, skipped: language.skipped };
  }
  if (queue === "remux") {
    return { pending: remux.pending, running: remux.running, done: remux.done, failed: remux.failed, skipped: 0 };
  }
  return addTotals(
    { pending: language.pending, running: language.running, done: language.done, failed: language.failed, skipped: language.skipped },
    remux,
  );
}

function stamp(job: TaskJob): number {
  const value = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function mapDetect(status: DetectJobStatus, page: number, pageSize: number, db: Database.Database): { jobs: TaskJob[]; total: number } {
  const list = listDetectJobs(db, { status, page, pageSize });
  return {
    total: list.total,
    jobs: list.jobs.map((job) => ({
      key: `language:${job.id}`,
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

function mapRemux(status: RemuxJobStatus, page: number, pageSize: number, db: Database.Database): { jobs: TaskJob[]; total: number } {
  const list = listRemuxJobs(db, { status, page, pageSize });
  return {
    total: list.total,
    jobs: list.jobs.map((job) => ({
      key: `remux:${job.id}`,
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

/** List language and remux jobs for the Tasks page. */
export function listTaskJobs(
  db: Database.Database,
  query: { queue: TaskQueue | "all"; status: TaskStatus; page: number; pageSize: number },
): { jobs: TaskJob[]; total: number } {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize) || 50));
  const page = Math.max(1, Math.trunc(query.page) || 1);

  if (query.queue === "language") {
    if (query.status !== "pending" && query.status !== "running" && query.status !== "done" && query.status !== "failed" && query.status !== "skipped") {
      return { jobs: [], total: 0 };
    }
    return mapDetect(query.status, page, pageSize, db);
  }

  if (query.queue === "remux") {
    if (query.status === "skipped") return { jobs: [], total: 0 };
    return mapRemux(query.status, page, pageSize, db);
  }

  if (query.status === "skipped") return mapDetect("skipped", page, pageSize, db);

  // Pull enough from each side to page correctly after a merged sort.
  const need = page * pageSize;
  const language = mapDetect(query.status, 1, need, db);
  const remux = mapRemux(query.status, 1, need, db);
  const merged =
    query.status === "pending"
      ? [...language.jobs, ...remux.jobs].sort((a, b) => a.id - b.id || a.key.localeCompare(b.key))
      : [...language.jobs, ...remux.jobs].sort((a, b) => stamp(b) - stamp(a) || b.id - a.id || a.key.localeCompare(b.key));
  const total = language.total + remux.total;
  const start = (page - 1) * pageSize;
  return { jobs: merged.slice(start, start + pageSize), total };
}
