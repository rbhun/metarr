export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startDetectWorker } = await import("@/lib/detect/worker");
  const { startRemuxWorker } = await import("@/lib/remux/worker");
  const { startRewrapWorker } = await import("@/lib/rewrap/worker");
  const { startSyncWorker } = await import("@/lib/sync-worker");
  startDetectWorker();
  startRemuxWorker();
  startRewrapWorker();
  startSyncWorker();
}
