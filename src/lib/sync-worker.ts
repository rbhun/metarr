import { getDb, getMeta, listConnectors } from "@/lib/db";
import { readSyncSchedule, syncIsDue } from "@/lib/sync-schedule";
import { getSyncStatus, startSync } from "@/lib/sync";

const globalForSyncWorker = globalThis as { __metarrSyncWorker?: { timer: NodeJS.Timeout | null; working: boolean } };

function state() {
  if (!globalForSyncWorker.__metarrSyncWorker) globalForSyncWorker.__metarrSyncWorker = { timer: null, working: false };
  return globalForSyncWorker.__metarrSyncWorker;
}

function libraryCanSync(): boolean {
  return listConnectors().some((connector) => connector.enabled && connector.baseUrl.trim() && connector.apiKey.trim());
}

async function step() {
  const db = getDb();
  const settings = readSyncSchedule(db);
  if (!settings.enabled || !libraryCanSync() || getSyncStatus().running) return;
  if (!syncIsDue(getMeta(db, "last_sync_at"), settings.intervalHours, Date.now())) return;
  startSync();
}

async function loop() {
  const current = state();
  if (current.working) return;
  current.working = true;
  try {
    await step();
  } catch (caught) {
    console.error("Library resync stopped.", caught);
  } finally {
    current.working = false;
  }
  current.timer = setTimeout(() => {
    void loop();
  }, 60_000);
}

export function startSyncWorker() {
  const current = state();
  if (current.timer) return;
  current.timer = setTimeout(() => {
    void loop();
  }, 1_000);
}

export function kickSyncWorker() {
  startSyncWorker();
  const current = state();
  if (current.working) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    void loop();
  }, 50);
}
