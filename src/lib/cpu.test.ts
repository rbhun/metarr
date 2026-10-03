import assert from "node:assert/strict";
import test from "node:test";
import {
  cgroupJoin,
  cgroupRelPath,
  cgroupStatPaths,
  cpuPercent,
  dockerPercent,
  timesFromCpus,
  timesFromProcStat,
  usageFromCpuStat,
  usageFromCpuacct,
} from "@/lib/cpu";

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

test("cgroup v2 usage_usec is this container's CPU time", () => {
  assert.equal(usageFromCpuStat("usage_usec 2000000\nuser_usec 1500000\nsystem_usec 500000\n"), 2_000_000);
  assert.equal(usageFromCpuacct("2000000000\n"), 2_000_000);
});

test("docker percent is this container's share of every core", () => {
  const previous = { usageUs: 1_000_000, atMs: 1000 };
  const next = { usageUs: 1_000_000 + 250_000, atMs: 1250 };
  assert.equal(dockerPercent(previous, next, 4), 25);
  assert.equal(dockerPercent(previous, next, 1), 100);
  assert.equal(dockerPercent(previous, { usageUs: 1_000_000, atMs: 1000 }, 4), null);
});

test("cgroup rel path prefers unified v2 over a v1 cpu line", () => {
  assert.equal(
    cgroupRelPath("0::/system.slice/pod-x/cursor-agent/workload\n"),
    "/system.slice/pod-x/cursor-agent/workload",
  );
  assert.equal(cgroupRelPath("0::/\n"), "/");
  assert.equal(cgroupRelPath("0::\n"), "/");
  assert.equal(
    cgroupRelPath("12:cpu,cpuacct:/docker/abc\n0::/docker/abc\n"),
    "/docker/abc",
  );
  assert.equal(
    cgroupRelPath("11:memory:/docker/abc\n12:cpu,cpuacct:/docker/abc\n"),
    "/docker/abc",
  );
  assert.equal(cgroupRelPath("11:memory:/\n"), null);
});

test("cgroup join uses this process path, not the host root, when nested", () => {
  assert.equal(cgroupJoin("/", "cpu.stat"), "/sys/fs/cgroup/cpu.stat");
  assert.equal(
    cgroupJoin("/system.slice/pod-x/workload", "cpu.stat"),
    "/sys/fs/cgroup/system.slice/pod-x/workload/cpu.stat",
  );
  assert.equal(
    cgroupJoin("/docker/abc", "cpuacct.usage", "/sys/fs/cgroup/cpuacct"),
    "/sys/fs/cgroup/cpuacct/docker/abc/cpuacct.usage",
  );
  assert.equal(cgroupStatPaths("/")[0], "/sys/fs/cgroup/cpu.stat");
  assert.notEqual(cgroupStatPaths("/system.slice/pod-x/workload")[0], "/sys/fs/cgroup/cpu.stat");
});
