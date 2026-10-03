import { clearJobs, detectCounts, jobTotals as languageTotals, retryAllFailedJobs, retryFailedJob, type DetectJobStatus } from "@/lib/detect/store";
import { clearMergeJobs, mergeTotals, retryAllFailedMerge, retryFailedMerge, type MergeJobStatus } from "@/lib/merge/store";
import { kickMergeWorker, startMergeWorker } from "@/lib/merge/worker";
import { clearRemuxJobs, remuxCounts, remuxTotals, retryAllFailedRemux, retryFailedRemux, type RemuxJobStatus } from "@/lib/remux/store";
import { kickRemuxWorker, startRemuxWorker } from "@/lib/remux/worker";
import { clearRewrapJobs, retryAllFailedRewrap, retryFailedRewrap, rewrapTotals, type RewrapJobStatus } from "@/lib/rewrap/store";
import { kickRewrapWorker, startRewrapWorker } from "@/lib/rewrap/worker";
import { kickDetectWorker, startDetectWorker } from "@/lib/detect/worker";
import { listTaskJobs, taskTotalsFor, taskTotalsSum, type TaskQueue, type TaskStatus, type TaskStatusFilter } from "@/lib/tasks";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set<TaskStatus>(["pending", "running", "done", "failed", "skipped"]);
const QUEUES = new Set<TaskQueue | "all">(["all", "language", "remux", "rewrap", "merge"]);

function parseStatus(raw: string | null): TaskStatusFilter {
  if (!raw || raw === "all") return "all";
  if (STATUSES.has(raw as TaskStatus)) return raw as TaskStatus;
  return "all";
}

export async function GET(request: Request) {
  startDetectWorker();
  startRemuxWorker();
  startRewrapWorker();
  startMergeWorker();
  const db = getDb();
  const url = new URL(request.url);
  const status = parseStatus(url.searchParams.get("status"));
  const rawQueue = url.searchParams.get("queue") ?? "all";
  const queue = QUEUES.has(rawQueue as TaskQueue | "all") ? (rawQueue as TaskQueue | "all") : "all";
  const page = Math.max(1, Math.trunc(Number(url.searchParams.get("page")) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("pageSize")) || 50)));
  const list = listTaskJobs(db, { queue, status, page, pageSize });
  const totals = taskTotalsFor(db, queue);
  return NextResponse.json({
    queue,
    status,
    totals,
    allTotal: taskTotalsSum(totals),
    languageTotals: languageTotals(db),
    remuxTotals: remuxTotals(db),
    rewrapTotals: rewrapTotals(db),
    mergeTotals: mergeTotals(db),
    counts: { ...detectCounts(db), remux: remuxCounts(db) },
    jobs: list.jobs,
    total: list.total,
    page,
    pageSize,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const queue =
    record.queue === "all" ||
    record.queue === "language" ||
    record.queue === "remux" ||
    record.queue === "rewrap" ||
    record.queue === "merge"
      ? record.queue
      : null;
  const redoAll = record.all === true;
  const id = typeof record.id === "number" && Number.isInteger(record.id) && record.id > 0 ? record.id : null;
  if (!queue) return NextResponse.json({ error: "Choose a failed task to redo." }, { status: 400 });
  const db = getDb();
  if (redoAll) {
    let retried = 0;
    if (queue === "all" || queue === "language") retried += retryAllFailedJobs(db);
    if (queue === "all" || queue === "remux") retried += retryAllFailedRemux(db);
    if (queue === "all" || queue === "rewrap") retried += retryAllFailedRewrap(db);
    if (queue === "all" || queue === "merge") retried += retryAllFailedMerge(db);
    if (retried > 0) {
      kickDetectWorker();
      kickRemuxWorker();
      kickRewrapWorker();
      kickMergeWorker();
    }
    return NextResponse.json({ result: "retried", retried, totals: taskTotalsFor(db, queue) });
  }
  if (queue === "all" || !id) return NextResponse.json({ error: "Choose a failed task to redo." }, { status: 400 });
  const result =
    queue === "language"
      ? retryFailedJob(db, id)
      : queue === "rewrap"
        ? retryFailedRewrap(db, id)
        : queue === "merge"
          ? retryFailedMerge(db, id)
          : retryFailedRemux(db, id);
  if (result === "missing") return NextResponse.json({ error: "That failed task is no longer there." }, { status: 404 });
  if (result === "retried") {
    if (queue === "language") kickDetectWorker();
    else if (queue === "rewrap") kickRewrapWorker();
    else if (queue === "merge") kickMergeWorker();
    else kickRemuxWorker();
  }
  return NextResponse.json({ result, totals: taskTotalsFor(db, queue) });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const rawQueue = url.searchParams.get("queue") ?? "all";
  const queue = QUEUES.has(rawQueue as TaskQueue | "all") ? (rawQueue as TaskQueue | "all") : "all";
  const status = parseStatus(url.searchParams.get("status"));
  if (status === "all" || status === "running") {
    return NextResponse.json({ error: "Choose one finished or waiting filter to clear." }, { status: 400 });
  }
  const db = getDb();
  let removed = 0;
  if (queue === "all" || queue === "language") removed += clearJobs(db, status as DetectJobStatus);
  if ((queue === "all" || queue === "remux") && status !== "skipped") removed += clearRemuxJobs(db, status as RemuxJobStatus);
  if ((queue === "all" || queue === "rewrap") && status !== "skipped") removed += clearRewrapJobs(db, status as RewrapJobStatus);
  if ((queue === "all" || queue === "merge") && status !== "skipped") removed += clearMergeJobs(db, status as MergeJobStatus);
  kickRemuxWorker();
  kickRewrapWorker();
  kickMergeWorker();
  return NextResponse.json({
    removed,
    totals: taskTotalsFor(db, queue),
  });
}
