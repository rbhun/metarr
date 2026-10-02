import { AsyncLocalStorage } from "node:async_hooks";

/** Thrown when the user stops a library sync. */
export class SyncCancelledError extends Error {
  constructor(message = "Sync cancelled.") {
    super(message);
    this.name = "SyncCancelledError";
  }
}

export function isSyncCancelled(error: unknown): boolean {
  return error instanceof SyncCancelledError || (error instanceof Error && error.name === "SyncCancelledError");
}

const storage = new AsyncLocalStorage<AbortSignal>();

export function syncAbortSignal(): AbortSignal | undefined {
  return storage.getStore();
}

export function runWithSyncAbort<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return storage.run(signal, work);
}

export function throwIfSyncCancelled(signal?: AbortSignal | null): void {
  if (signal?.aborted || syncAbortSignal()?.aborted) throw new SyncCancelledError();
}
