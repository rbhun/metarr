import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDeployRun, readDeployState, requestDeploy } from "@/lib/deploy";
import { VERSION } from "@/lib/version";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "metarr-run-"));
}

test("without the host helper the Update button stays off", () => {
  const run = tempDir();
  try {
    const state = readDeployState(run);
    assert.equal(state.available, false);
    assert.equal(state.version, VERSION);
    assert.equal(requestDeploy(run), "unavailable");
    assert.equal(fs.existsSync(path.join(run, "deploy-request")), false);
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
});

test("a request is left once, and a stuck one can be sent again", () => {
  const run = tempDir();
  try {
    fs.writeFileSync(path.join(run, "watcher"), "/opt/metarr\n");
    assert.equal(requestDeploy(run), "requested");
    assert.equal(requestDeploy(run), "already");
    const request = path.join(run, "deploy-request");
    assert.equal(readDeployState(run).stuck, false);
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(request, old, old);
    assert.equal(readDeployState(run).stuck, true);
    assert.equal(requestDeploy(run), "requested");
    fs.rmSync(request);
    fs.writeFileSync(path.join(run, "deploy-status.json"), JSON.stringify({ state: "running", startedAt: "2026-09-29T17:00:00Z", finishedAt: null, exitCode: null, before: "abc", after: null }));
    assert.equal(requestDeploy(run), "already");
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
});

test("the status file is read defensively", () => {
  assert.equal(parseDeployRun(null), null);
  assert.equal(parseDeployRun("not json"), null);
  assert.equal(parseDeployRun('{"state":"weird"}'), null);
  assert.deepEqual(parseDeployRun('{"state":"failed","startedAt":"a","finishedAt":"b","exitCode":1,"before":"x","after":"x"}'), {
    state: "failed",
    startedAt: "a",
    finishedAt: "b",
    exitCode: 1,
    before: "x",
    after: "x",
  });
});

test("the host script runs deploy.sh, logs it, records the result, and clears the request", () => {
  const root = tempDir();
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.mkdirSync(path.join(root, "run"));
    fs.copyFileSync(path.join(process.cwd(), "scripts", "deploy-watch.sh"), path.join(root, "scripts", "deploy-watch.sh"));
    fs.writeFileSync(path.join(root, "deploy.sh"), '#!/bin/sh\necho "pulling"\necho "oops" >&2\nexit "${FAKE_EXIT:-0}"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, "run", "watcher"), `${root}\n`);
    assert.equal(requestDeploy(path.join(root, "run")), "requested");

    execFileSync("sh", [path.join(root, "scripts", "deploy-watch.sh")]);
    let state = readDeployState(path.join(root, "run"));
    assert.equal(state.requestedAt, null);
    assert.equal(state.run?.state, "done");
    assert.equal(state.run?.exitCode, 0);
    assert.match(state.log, /Update requested from Metarr Settings[\s\S]*pulling[\s\S]*oops/);

    assert.throws(() => execFileSync("sh", [path.join(root, "scripts", "deploy-watch.sh")], { env: { ...process.env, FAKE_EXIT: "3" } }));
    state = readDeployState(path.join(root, "run"));
    assert.equal(state.run?.state, "failed");
    assert.equal(state.run?.exitCode, 3);
    assert.ok(state.run?.finishedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
