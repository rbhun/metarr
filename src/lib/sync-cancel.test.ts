import assert from "node:assert/strict";
import test from "node:test";
import { SyncCancelledError, isSyncCancelled, setSyncAbortSignal, throwIfSyncCancelled } from "@/lib/sync-cancel";

test("throwIfSyncCancelled throws when the signal is aborted", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => throwIfSyncCancelled(controller.signal), SyncCancelledError);
});

test("setSyncAbortSignal exposes the active sync abort to throwIfSyncCancelled", () => {
  const controller = new AbortController();
  setSyncAbortSignal(controller.signal);
  try {
    throwIfSyncCancelled();
    controller.abort();
    assert.throws(() => throwIfSyncCancelled(), SyncCancelledError);
  } finally {
    setSyncAbortSignal(null);
  }
});

test("isSyncCancelled recognizes the error", () => {
  assert.equal(isSyncCancelled(new SyncCancelledError()), true);
  assert.equal(isSyncCancelled(new Error("other")), false);
});
