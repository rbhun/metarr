import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseIo, parseStat, removeWorkDir, stuckMessage, stuckTools, stuckWaiting, watchStall, type Sample } from "@/lib/stuck";

const onLinux = fs.existsSync(`/proc/${process.pid}/stat`);

test("process state and byte counts are read from /proc", () => {
  const stat = "167772 (ffmpeg (copy) x) D 1279 167772 1279 0 -1 4194560 1 0 0 0 5 9 0 0 39 19 1 0 81234567 2000 300";
  assert.deepEqual(parseStat(stat), { state: "D", start: "81234567" });
  assert.equal(parseStat("garbage"), null);
  assert.equal(parseIo("rchar: 2836504315\nwchar: 2836276152\nsyscr: 84104\n"), 5672780467);
  assert.equal(parseIo("read_bytes: 1\n"), null);
});

test("the message says the NAS is holding the tool and what to do", () => {
  assert.match(stuckMessage("ffmpeg"), /^ffmpeg has been stuck for 10 minutes waiting for the NAS.*left unchanged.*nfs-kernel-server.*carries on by itself/);
  assert.match(stuckWaiting([{ pid: 1, command: "ffmpeg", since: new Date(2026, 9, 15, 20, 52).toISOString() }]), /^Waiting: ffmpeg is stuck on the NAS since 2026-10-15 20:52\./);
});

test("a tool that keeps moving bytes, or is not in disk wait, is never called stuck", async () => {
  let io = 0;
  const calls: string[] = [];
  const moving = watchStall(42, "ffmpeg", () => calls.push("moving"), { stallMs: 30, checkMs: 5, read: () => ({ state: "D", start: "1", io: (io += 1) }) });
  const sleeping = watchStall(43, "ffmpeg", () => calls.push("sleeping"), { stallMs: 30, checkMs: 5, read: () => ({ state: "S", start: "1", io: 7 }) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  moving();
  sleeping();
  assert.deepEqual(calls, []);
});

test("a tool stuck in disk wait is reported, pauses scratch cleanup, and clears once it is gone", { skip: !onLinux }, async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  const real = parseStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  assert.ok(real);
  const frozen: Sample = { state: "D", start: real.start, io: 5 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-stuck-"));
  try {
    const error = await new Promise<Error>((resolve) => {
      watchStall(pid, "ffmpeg", resolve, { stallMs: 20, checkMs: 5, read: () => frozen });
    });
    assert.match(error.message, /^ffmpeg has been stuck/);
    assert.deepEqual(stuckTools().map((tool) => [tool.pid, tool.command]), [[pid, "ffmpeg"]]);
    removeWorkDir(dir);
    assert.ok(fs.existsSync(dir), "a stuck tool may still hold a file there, and touching it would hang Metarr too");
  } finally {
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
  assert.deepEqual(stuckTools(), []);
  removeWorkDir(dir);
  assert.equal(fs.existsSync(dir), false);
});
