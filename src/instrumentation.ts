export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startDetectWorker } = await import("@/lib/detect/worker");
  const { startRemuxWorker } = await import("@/lib/remux/worker");
  startDetectWorker();
  startRemuxWorker();
}
