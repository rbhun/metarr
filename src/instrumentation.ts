export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { applyTimeZone } = await import("@/lib/clock");
  const { getDb } = await import("@/lib/db");
  applyTimeZone(getDb());
  const { startDetectWorker } = await import("@/lib/detect/worker");
  const { startRemuxWorker } = await import("@/lib/remux/worker");
  const { startRewrapWorker } = await import("@/lib/rewrap/worker");
  const { startMergeWorker } = await import("@/lib/merge/worker");
  const { startSyncWorker } = await import("@/lib/sync-worker");
  startDetectWorker();
  startRemuxWorker();
  startRewrapWorker();
  startMergeWorker();
  startSyncWorker();
}
