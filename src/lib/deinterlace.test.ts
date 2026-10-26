import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "@/lib/db";
import { classifyInterlace, detectInterlace, interlaceFilter, parseIdet, sampleStarts, type IdetCounts } from "@/lib/rewrap/interlace";
import { deinterlacePlan, rewrapArgs, rewrapAvi, type Probe } from "@/lib/rewrap/run";
import { deinterlacedTarget } from "@/lib/rewrap/source";
import { claimNextRewrap, enqueueRewraps, readRewrapSettings, writeRewrapSettings } from "@/lib/rewrap/store";

function counts(values: Partial<IdetCounts>): IdetCounts {
  return { tff: 0, bff: 0, progressive: 0, undetermined: 0, repeated: 0, ...values };
}

test("idet totals come from the last frame's running count", () => {
  const lines = [
    "lavfi.idet.repeated.top=1.00",
    "lavfi.idet.repeated.bottom=0.00",
    "lavfi.idet.multiple.tff=10.00",
    "lavfi.idet.multiple.progressive=2.00",
    "lavfi.idet.single.tff=99.00",
    "lavfi.idet.repeated.top=3.00",
    "lavfi.idet.repeated.bottom=2.00",
    "lavfi.idet.multiple.tff=280.00",
    "lavfi.idet.multiple.bff=1.00",
    "lavfi.idet.multiple.progressive=15.00",
    "lavfi.idet.multiple.undetermined=4.00",
  ];
  assert.deepEqual(parseIdet(lines), { tff: 280, bff: 1, progressive: 15, undetermined: 4, repeated: 5 });
});

test("only a clear field order counts as interlaced; busy progressive footage is left alone", () => {
  assert.deepEqual(classifyInterlace(counts({ tff: 280, progressive: 20 })).kind, "interlaced");
  assert.equal(classifyInterlace(counts({ bff: 900 })).order, "bff");
  assert.equal(classifyInterlace(counts({ progressive: 890, tff: 10 })).kind, "progressive");
  assert.equal(classifyInterlace(counts({ tff: 112, bff: 113, progressive: 80 })).kind, "unclear");
  assert.equal(classifyInterlace(counts({ tff: 300, repeated: 120 })).kind, "telecined");
  assert.equal(classifyInterlace(counts({ tff: 20 })).kind, "unclear");
});

test("the filter matches what was found, and nothing is re-encoded for progressive video unless asked", () => {
  assert.equal(interlaceFilter(classifyInterlace(counts({ bff: 900 }))), "bwdif=mode=send_field:parity=bff:deint=all,format=yuv420p");
  assert.equal(interlaceFilter(classifyInterlace(counts({ tff: 300, repeated: 120 }))), "fieldmatch=order=tff,bwdif=deint=interlaced,decimate,format=yuv420p");
  const progressive = classifyInterlace(counts({ progressive: 900 }));
  assert.equal(interlaceFilter(progressive), null);
  assert.match(interlaceFilter(progressive, true) ?? "", /^bwdif=mode=send_field:parity=tff/);
  assert.deepEqual(sampleStarts(null), [0]);
  assert.deepEqual(sampleStarts(6000), [1200, 3000, 4800]);
});

test("the job message says what happened to the picture", () => {
  const interlaced = classifyInterlace(counts({ tff: 900 }));
  const progressive = classifyInterlace(counts({ progressive: 900 }));
  assert.deepEqual(deinterlacePlan("off", interlaced), { filter: null, note: "" });
  assert.match(deinterlacePlan("auto", interlaced).note, /interlaced, top field first, so it was deinterlaced/);
  assert.deepEqual(deinterlacePlan("auto", progressive), { filter: null, note: " The picture is progressive, so it was copied." });
  assert.match(deinterlacePlan("force", progressive).note, /looked progressive, but it was deinterlaced as asked/);
  assert.equal(deinterlacePlan("auto", "failed").filter, null);
  assert.ok(deinterlacePlan("force", "failed").filter);
});

test("a deinterlaced rewrap re-encodes only the first video stream", () => {
  const probe: Probe = {
    duration: 100,
    streams: [
      { index: 0, codecType: "video", codecName: "mpeg4" },
      { index: 1, codecType: "audio", codecName: "mp3" },
    ],
  };
  const copied = rewrapArgs("in.avi", "out.mkv", probe, { languages: [], firstLanguage: "" }).args;
  assert.ok(copied.includes("mpeg4_unpack_bframes"));
  assert.ok(!copied.includes("libx264"));
  const encoded = rewrapArgs("in.avi", "out.mkv", probe, { languages: [], firstLanguage: "", videoFilter: "bwdif" }).args;
  assert.ok(!encoded.includes("mpeg4_unpack_bframes"));
  const at = encoded.indexOf("-filter:v:0");
  assert.deepEqual(encoded.slice(at, at + 4), ["-filter:v:0", "bwdif", "-c:v:0", "libx264"]);
  assert.ok(encoded.indexOf("-c") < at, "every other stream is still copied");
  assert.equal(deinterlacedTarget("/m/Film (1999)/Film.avi"), "/m/Film (1999)/Film.deinterlaced.mkv");
});

test("automatic deinterlacing is on by default and deinterlace jobs queue beside rewraps", () => {
  const db = new Database(":memory:");
  migrate(db);
  assert.equal(readRewrapSettings(db).deinterlace, true);
  writeRewrapSettings(db, { deinterlace: false });
  assert.equal(readRewrapSettings(db).deinterlace, false);
  assert.equal(enqueueRewraps(db, [{ path: "/m/Film.avi" }, { path: "/m/Film.avi", mode: "deinterlace" }]).added, 2);
  assert.equal(claimNextRewrap(db)?.mode, "rewrap");
  assert.equal(claimNextRewrap(db)?.mode, "deinterlace");
});

function videoOf(file: string): { codec: string; rate: string } {
  const [codec, rate] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,avg_frame_rate", "-of", "csv=p=0", file])
    .toString()
    .trim()
    .split(",");
  return { codec: codec ?? "", rate: rate ?? "" };
}

test("an interlaced AVI is recognized and deinterlaced; a progressive one is copied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-deinterlace-"));
  try {
    const make = (name: string, rate: string, filter: string, interlaced: boolean) =>
      execFileSync("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=720x576:r=${rate}:d=8`, "-f", "lavfi", "-i", "sine=d=8",
        "-vf", filter, ...(interlaced ? ["-flags", "+ildct+ilme"] : []), "-c:v", "mpeg4", "-q:v", "3", "-c:a", "mp3", path.join(root, name),
      ]);
    make("Interlaced.avi", "50", "gblur=sigma=1.2,tinterlace=mode=interleave_top", true);
    make("Progressive.avi", "25", "gblur=sigma=1.2", false);
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=720x480:r=24000/1001:d=8", "-vf", "gblur=sigma=1.2,telecine=pattern=23",
      "-flags", "+ildct+ilme", "-c:v", "mpeg4", "-q:v", "3", path.join(root, "Telecined.avi"),
    ]);
    assert.equal((await detectInterlace(path.join(root, "Telecined.avi"), 8)).kind, "telecined");

    const run = (name: string, deinterlace: "auto" | "force") =>
      rewrapAvi({ source: path.join(root, name), workDir: path.join(root, "work"), languages: [], firstLanguage: "", deinterlace, onProgress: () => undefined });

    assert.match(await run("Interlaced.avi", "auto"), /interlaced, top field first, so it was deinterlaced/);
    assert.deepEqual(videoOf(path.join(root, "Interlaced.mkv")), { codec: "h264", rate: "50/1" });

    assert.match(await run("Progressive.avi", "auto"), /progressive, so it was copied/);
    assert.equal(videoOf(path.join(root, "Progressive.mkv")).codec, "mpeg4");

    assert.match(await run("Progressive.avi", "force"), /Saved Progressive\.deinterlaced\.mkv.*deinterlaced as asked/);
    assert.equal(videoOf(path.join(root, "Progressive.deinterlaced.mkv")).codec, "h264");
    for (const name of ["Interlaced.avi", "Progressive.avi", "Progressive.mkv"]) assert.ok(fs.existsSync(path.join(root, name)), `${name} stays`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
