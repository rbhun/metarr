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

let active: AbortSignal | null = null;

export function setSyncAbortSignal(signal: AbortSignal | null): void {
  active = signal;
}

export function syncAbortSignal(): AbortSignal | undefined {
  return active ?? undefined;
}

export function throwIfSyncCancelled(signal?: AbortSignal | null): void {
  if (signal?.aborted || active?.aborted) throw new SyncCancelledError();
}
