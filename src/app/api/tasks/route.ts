import { clearPendingJobs, detectCounts, jobTotals as languageTotals } from "@/lib/detect/store";
import { clearPendingRemux, remuxCounts, remuxTotals } from "@/lib/remux/store";
import { kickRemuxWorker, startRemuxWorker } from "@/lib/remux/worker";
import { startDetectWorker } from "@/lib/detect/worker";
import { listTaskJobs, taskTotalsFor, type TaskQueue, type TaskStatus } from "@/lib/tasks";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set<TaskStatus>(["pending", "running", "done", "failed", "skipped"]);
const QUEUES = new Set<TaskQueue | "all">(["all", "language", "remux"]);

export async function GET(request: Request) {
  startDetectWorker();
  startRemuxWorker();
  const db = getDb();
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus && STATUSES.has(rawStatus as TaskStatus) ? (rawStatus as TaskStatus) : "failed";
  const rawQueue = url.searchParams.get("queue") ?? "all";
  const queue = QUEUES.has(rawQueue as TaskQueue | "all") ? (rawQueue as TaskQueue | "all") : "all";
  const page = Math.max(1, Math.trunc(Number(url.searchParams.get("page")) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("pageSize")) || 50)));
  const list = listTaskJobs(db, { queue, status, page, pageSize });
  return NextResponse.json({
    queue,
    status,
    totals: taskTotalsFor(db, queue),
    languageTotals: languageTotals(db),
    remuxTotals: remuxTotals(db),
    counts: { ...detectCounts(db), remux: remuxCounts(db) },
    jobs: list.jobs,
    total: list.total,
    page,
    pageSize,
  });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const rawQueue = url.searchParams.get("queue") ?? "all";
  const queue = QUEUES.has(rawQueue as TaskQueue | "all") ? (rawQueue as TaskQueue | "all") : "all";
  const db = getDb();
  let removed = 0;
  if (queue === "all" || queue === "language") removed += clearPendingJobs(db);
  if (queue === "all" || queue === "remux") removed += clearPendingRemux(db);
  kickRemuxWorker();
  return NextResponse.json({
    removed,
    totals: taskTotalsFor(db, queue),
  });
}
