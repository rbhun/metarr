import assert from "node:assert/strict";
import test from "node:test";
import { cpuPercent, timesFromCpus, timesFromProcStat } from "@/lib/cpu";

test("proc stat idle and iowait count as idle time", () => {
  const times = timesFromProcStat("cpu  10 0 10 70 10 0 0 0 0 0\ncpu0 5 0 5 35 5 0 0 0 0 0\n");
  assert.deepEqual(times, { idle: 80, total: 100 });
});

test("cpu percent is the busy share between two samples", () => {
  assert.equal(cpuPercent({ idle: 80, total: 100 }, { idle: 90, total: 200 }), 90);
  assert.equal(cpuPercent({ idle: 50, total: 100 }, { idle: 100, total: 150 }), 0);
  assert.equal(cpuPercent({ idle: 10, total: 10 }, { idle: 10, total: 10 }), null);
});

test("os.cpus times roll into one idle and total", () => {
  const times = timesFromCpus([
    { times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } },
    { times: { user: 20, nice: 0, sys: 0, idle: 80, irq: 0 } },
  ]);
  assert.deepEqual(times, { idle: 160, total: 200 });
});
