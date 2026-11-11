import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { killTool, stuckTools, toolFile } from "@/lib/stuck-tools";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A child that ignores SIGKILL, the way a process blocked on a hung NFS read does. */
function unkillable(pid: number): ChildProcess & { finish: () => void } {
  const child = new EventEmitter() as ChildProcess & { finish: () => void };
  Object.assign(child, { pid, exitCode: null, signalCode: null, kill: () => true });
  child.finish = () => {
    Object.assign(child, { signalCode: "SIGKILL" });
    child.emit("exit", null, "SIGKILL");
  };
  return child;
}

test("toolFile picks the ffmpeg input, else the last absolute path", () => {
  assert.equal(toolFile(["-y", "-i", "/mnt/media/Movies/A/A.mp4", "-c", "copy", "/scratch/A.mp4"]), "/mnt/media/Movies/A/A.mp4");
  assert.equal(toolFile(["--edit", "track:s1", "/mnt/media/B.mkv"]), "/mnt/media/B.mkv");
  assert.equal(toolFile(["-version"]), null);
});

test("a killed tool that does not exit is listed until it finally exits", async () => {
  const child = unkillable(74622);
  killTool(child, "ffmpeg", ["-i", "/mnt/media/Movies/The A-Team (2010)/The A-Team.mp4", "/scratch/out.mp4"], 20);
  assert.equal(stuckTools().length, 0);
  await wait(50);
  const listed = stuckTools().find((tool) => tool.pid === 74622);
  assert.equal(listed?.command, "ffmpeg");
  assert.equal(listed?.file, "/mnt/media/Movies/The A-Team (2010)/The A-Team.mp4");
  child.finish();
  assert.equal(stuckTools().some((tool) => tool.pid === 74622), false);
});

test("a tool that exits when killed is never listed", async () => {
  const child = spawn("sleep", ["30"]);
  const gone = new Promise((resolve) => child.once("exit", resolve));
  killTool(child, "sleep", ["30"], 20);
  await gone;
  await wait(50);
  assert.equal(stuckTools().some((tool) => tool.pid === child.pid), false);
});
