import assert from "node:assert/strict";
import test from "node:test";
import { SyncCancelledError, isSyncCancelled, runWithSyncAbort, throwIfSyncCancelled } from "@/lib/sync-cancel";

test("throwIfSyncCancelled throws when the signal is aborted", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => throwIfSyncCancelled(controller.signal), SyncCancelledError);
});

test("runWithSyncAbort exposes the signal to throwIfSyncCancelled", async () => {
  const controller = new AbortController();
  await runWithSyncAbort(controller.signal, async () => {
    throwIfSyncCancelled();
    controller.abort();
    assert.throws(() => throwIfSyncCancelled(), SyncCancelledError);
  });
});

test("isSyncCancelled recognizes the error", () => {
  assert.equal(isSyncCancelled(new SyncCancelledError()), true);
  assert.equal(isSyncCancelled(new Error("other")), false);
});
