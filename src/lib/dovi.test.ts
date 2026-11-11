import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { parsePlexItem } from "@/lib/connectors/plex";
import { migrate } from "@/lib/db";
import {
  checkDoviOutput,
  convertDolbyVision,
  damagedRpuMessage,
  doviTarget,
  doviTool,
  frameSpan,
  missingFrames,
  parseDoviProbe,
  parseFrameTimes,
  timestampFile,
  videoDelayMs,
  type DoviProbe,
} from "@/lib/dovi/run";
import { RpuRepair, crc32Mpeg2, rpuIsValid, unescapeNal } from "@/lib/dovi/rpu-repair";
import { rulesWhere } from "@/lib/filters";
import { videoFromProbe } from "@/lib/folder-scan";
import { hdrText } from "@/lib/format";
import { doviProfileOf } from "@/lib/media";
import { claimNextRewrap, enqueueRewraps, finishRewrap, finishedRewrapPaths } from "@/lib/rewrap/store";

/** One Dolby Vision profile 7 MEL RPU from the dovi_tool test assets. */
const PROFILE7_RPU =
  "AAAAARkICQhAYTZQrwA/+AH/wA/8AB//oAAAEAAADQAAAwCAAABoAAAEAAADAABAAAAgAAAgAAADAAQAAAMCAAADAgAAAwAAQAAAIAAAIAAANErMAABr1ErN8/nWOErMiZQAAAMCAAADABAAAAMAEAAAAwA4bESGAwwUvGEcCigAAAMDTHy1//4AAAMAAAMAAAMAAMBAHwHCogAwCABPkw8BARXwrkSDAfQAAIAAAAMAAPkfd+6A";

function probeOf(streams: Array<Partial<DoviProbe["streams"][number]> & { type: string }>, duration = 100): DoviProbe {
  return {
    duration,
    streams: streams.map((stream, index) => ({ index, codec: null, start: 0, frameRate: null, doviProfile: null, ...stream })),
  };
}

test("the Dolby Vision copy is saved beside the source with a DV8 name", () => {
  assert.equal(doviTarget("/movies/Basic Instinct (1992)/Basic Instinct.ts"), "/movies/Basic Instinct (1992)/Basic Instinct.DV8.mkv");
  assert.equal(doviTarget("/movies/Film/Film.mkv"), "/movies/Film/Film.DV8.mkv");
  assert.equal(doviTarget("/movies/Film/Film.DV8.mkv"), "/movies/Film/Film.DV8.mkv");
});

test("ffprobe side data gives the Dolby Vision profile, the start, and the frame rate", () => {
  const probe = parseDoviProbe(
    JSON.stringify({
      format: { duration: "7254.5" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "hevc", start_time: "1.483", r_frame_rate: "24000/1001", side_data_list: [{ dv_profile: 7 }] },
        { index: 1, codec_type: "audio", codec_name: "truehd", start_time: "1.400", r_frame_rate: "0/0" },
      ],
    }),
  );
  assert.equal(probe.duration, 7254.5);
  assert.deepEqual(probe.streams[0], { index: 0, type: "video", codec: "hevc", start: 1.483, frameRate: "24000/1001", doviProfile: 7 });
  assert.equal(probe.streams[1]?.frameRate, null);
  assert.equal(videoDelayMs(probe), 83);
  assert.equal(videoDelayMs(probeOf([{ type: "video", start: 0 }, { type: "audio", start: 0.5 }])), 0);
});

test("a converted file is kept only with profile 8, every audio track, the same length, and the audio in place", () => {
  const source = probeOf([{ type: "video", doviProfile: 7, start: 1.5 }, { type: "audio", start: 1.4 }, { type: "audio", start: 1.4 }]);
  const good = probeOf([{ type: "video", doviProfile: 8, start: 0.1 }, { type: "audio", start: 0 }, { type: "audio", start: 0 }]);
  assert.equal(checkDoviOutput(source, good), null);
  assert.match(checkDoviOutput(source, probeOf([{ type: "video", doviProfile: 7 }, { type: "audio" }, { type: "audio" }])) ?? "", /Dolby Vision 7, not 8/);
  assert.match(checkDoviOutput(source, probeOf([{ type: "video" }, { type: "audio" }, { type: "audio" }])) ?? "", /no Dolby Vision/);
  assert.match(checkDoviOutput(source, probeOf([{ type: "video", doviProfile: 8 }, { type: "audio" }])) ?? "", /1 of the 2 audio/);
  assert.match(checkDoviOutput(source, { ...good, duration: 90 }) ?? "", /runs 90 seconds/);
  const shifted = probeOf([{ type: "video", doviProfile: 8, start: 0 }, { type: "audio", start: 0 }, { type: "audio", start: 0 }]);
  assert.match(checkDoviOutput(source, shifted) ?? "", /audio would move 100 ms/);
});

test("the file scan reads the Dolby Vision profile and HDR from ffprobe", () => {
  assert.deepEqual(videoFromProbe({ streams: [{ codec_type: "video", color_transfer: "smpte2084", side_data_list: [{ dv_profile: 7 }] }] }), {
    hdr: "Dolby Vision",
    doviProfile: 7,
  });
  assert.deepEqual(videoFromProbe({ streams: [{ codec_type: "video", color_transfer: "smpte2084" }] }), { hdr: "HDR10", doviProfile: null });
  assert.deepEqual(videoFromProbe({ streams: [{ codec_type: "video", color_transfer: "arib-std-b67" }] }), { hdr: "HLG", doviProfile: null });
  assert.deepEqual(videoFromProbe({ streams: [{ codec_type: "video", color_transfer: "bt709" }] }), { hdr: "none", doviProfile: null });
  assert.equal(videoFromProbe({ streams: [{ codec_type: "audio" }] }), null);
});

test("Plex reports the Dolby Vision profile on the video stream", () => {
  const parsed = parsePlexItem({
    ratingKey: "30",
    type: "movie",
    title: "Basic Instinct",
    year: 1992,
    Media: {
      videoResolution: "4k",
      Part: {
        file: "/movies/Basic Instinct (1992)/Basic Instinct.ts",
        Stream: [{ streamType: 1, codec: "hevc", DOVIPresent: true, DOVIProfile: 7, DOVIBLCompatID: 6, colorTrc: "smpte2084" }],
      },
    },
  });
  assert.equal(parsed?.files[0]?.hdr, "Dolby Vision");
  assert.equal(parsed?.files[0]?.doviProfile, 7);
  assert.equal(doviProfileOf("8"), 8);
  assert.equal(doviProfileOf("dv"), null);
  assert.equal(doviProfileOf(0), null);
  assert.equal(hdrText("Dolby Vision", 7), "Dolby Vision 7");
  assert.equal(hdrText("Dolby Vision", null), "Dolby Vision");
});

test("the library filter finds titles with a Dolby Vision profile", () => {
  assert.deepEqual(rulesWhere([{ id: "dv", field: "dovi", op: "eq", value: "7" }]), {
    clauses: ["(',' || IFNULL(dovi_profiles, '') || ',') LIKE ?"],
    params: ["%,7,%"],
  });
  assert.deepEqual(rulesWhere([{ id: "dv", field: "dovi", op: "neq", value: "7" }]), {
    clauses: ["NOT ((',' || IFNULL(dovi_profiles, '') || ',') LIKE ?)"],
    params: ["%,7,%"],
  });
  assert.deepEqual(rulesWhere([{ id: "dv", field: "dovi", op: "eq", value: "any" }]), { clauses: ["IFNULL(dovi_profiles, '') != ''"], params: [] });
});

test("a Dolby Vision job and an MKV rewrap of the same file queue separately", () => {
  const db = new Database(":memory:");
  migrate(db);
  const first = enqueueRewraps(db, [{ path: "/m/Film.ts" }, { path: "/m/Film.ts", mode: "dovi" }, { path: "/m/Film.ts", mode: "dovi" }]);
  assert.deepEqual(first, { added: 2, already: 0, promoted: 0 });
  assert.equal(enqueueRewraps(db, [{ path: "/m/Film.ts", mode: "dovi" }]).already, 1);
  const rewrap = claimNextRewrap(db);
  const dovi = claimNextRewrap(db);
  assert.equal(rewrap?.mode, "rewrap");
  assert.equal(dovi?.mode, "dovi");
  finishRewrap(db, dovi!.id, "done", "Saved Film.DV8.mkv");
  assert.deepEqual([...finishedRewrapPaths(db)], []);
});

test("frame times from ffmpeg become mkvmerge timestamps that keep a gap where frames were damaged", () => {
  const text = [
    "#tb 0: 1/90000",
    "#media_type 0: video",
    "0,      -7470,          0,     3753,    12312, 0x36efced7, S=1,        1",
    "0,      -3717,      11261,     3753,      500, 0x00000001",
    "0,          36,       3754,     3753,      400, 0x00000002",
    "0,       3789,       7507,     3753,      400, 0x00000003",
    "0,      11295,      26276,     3753,      400, 0x00000004",
  ].join("\n");
  const times = parseFrameTimes(text);
  assert.deepEqual(times, { tickSeconds: 1 / 90000, pts: [0, 11261, 3754, 7507, 26276] });
  assert.equal(timestampFile(times!), "# timestamp format v2\n0.000\n41.711\n83.411\n125.122\n291.956\n");
  assert.match(timestampFile(times!, 500), /^# timestamp format v2\n500\.000\n541\.711\n/);
  assert.equal(missingFrames(times!, "24000/1001"), 3);
  assert.equal(missingFrames(times!, null), 0);
  assert.equal(parseFrameTimes("#tb 0: 1/90000\n"), null);
});

test("a frame ffmpeg could not time takes its decode time or follows the frame before, never the smallest 64-bit number", () => {
  const text = [
    "#tb 0: 1/90000",
    "0,          0,          0,     3753,    12312, 0x36efced7",
    "0,       3753, -9223372036854775808,  3753,  500, 0x00000001",
    "0, -9223372036854775808, -9223372036854775808, 3753, 400, 0x00000002",
    "0,      11259,      11259,     3753,      400, 0x00000003",
  ].join("\n");
  const times = parseFrameTimes(text);
  assert.deepEqual(times?.pts, [0, 3753, 7506, 11259]);
  assert.ok(Math.abs(frameSpan(times!) - 11259 / 90000) < 1e-9);
  assert.equal(timestampFile(times!), "# timestamp format v2\n0.000\n41.700\n83.400\n125.100\n");
});

test("a Dolby Vision packet dovi_tool cannot read is explained, and other errors are left alone", () => {
  assert.match(damagedRpuMessage(new Error("Error: Invalid RPU last byte: 200 (dovi_tool exited with code 1.)")) ?? "", /damaged in a way Metarr cannot skip.*MakeMKV/);
  assert.equal(damagedRpuMessage(new Error("No space left on device")), null);
});

test("an RPU is valid when it ends in 0x80 after a matching CRC-32/MPEG-2", () => {
  assert.equal(crc32Mpeg2(Buffer.from("123456789")), 0x0376e6e7);
  assert.deepEqual([...unescapeNal(Buffer.from([1, 0, 0, 3, 1, 0, 0, 3]))], [1, 0, 0, 1, 0, 0]);
  const rpu = Buffer.from(PROFILE7_RPU, "base64").subarray(4);
  const nal = Buffer.concat([Buffer.from([0x7c, 0x01]), rpu]);
  assert.ok(rpuIsValid(nal));
  const broken = Buffer.from(nal);
  broken[broken.length - 1] = 200;
  assert.ok(!rpuIsValid(broken));
});

function repairAll(input: Buffer, chunk: number): { output: Buffer; repair: RpuRepair } {
  const repair = new RpuRepair();
  const parts: Buffer[] = [];
  repair.on("data", (part: Buffer) => parts.push(part));
  for (let at = 0; at < input.length; at += chunk) repair.write(input.subarray(at, at + chunk));
  repair.end();
  return { output: Buffer.concat(parts), repair };
}

test("an unreadable RPU borrows the one before it, and everything else passes through byte for byte", () => {
  const rpu = Buffer.concat([Buffer.from([0x7c, 0x01]), Buffer.from(PROFILE7_RPU, "base64").subarray(4)]);
  const broken = Buffer.from(rpu);
  broken[broken.length - 1] = 200;
  const slice = (fill: number) => Buffer.concat([Buffer.from([0x02, 0x01]), Buffer.alloc(300, fill)]);
  const unit = (nal: Buffer, four = false) => Buffer.concat([Buffer.from(four ? [0, 0, 0, 1] : [0, 0, 1]), nal]);
  const stream = Buffer.concat([unit(slice(7), true), unit(rpu), unit(slice(8), true), unit(broken), unit(slice(9), true), unit(rpu)]);
  const expected = Buffer.concat([unit(slice(7), true), unit(rpu), unit(slice(8), true), unit(rpu), unit(slice(9), true), unit(rpu)]);
  for (const size of [1, 2, 3, 5, 64, 100_000]) {
    const { output, repair } = repairAll(stream, size);
    assert.ok(output.equals(expected), `chunks of ${size}`);
    assert.deepEqual([repair.total, repair.replaced, repair.unrepaired], [3, 1, 0]);
  }
  const clean = Buffer.concat([Buffer.from([9, 9]), unit(slice(1)), unit(rpu)]);
  assert.ok(repairAll(clean, 7).output.equals(clean));
});

function hasTools(): boolean {
  const ok = (command: string, args: string[]) => spawnSync(command, args, { stdio: "ignore" }).status === 0;
  return ok(doviTool(), ["--version"]) && ok("mkvmerge", ["--version"]) && ok("ffmpeg", ["-hide_banner", "-h", "encoder=libx265"]);
}

function profile(file: string): string {
  return execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream_side_data=dv_profile", "-of", "csv=p=0", file]).toString().trim();
}

test("a Dolby Vision 7 transport stream becomes an 8.1 MKV beside it with the audio in sync", { skip: !hasTools() && "needs dovi_tool, mkvmerge, and ffmpeg with libx265" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-dovi-"));
  try {
    const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: root, stdio: "pipe" });
    fs.writeFileSync(path.join(root, "rpu.bin"), Buffer.from(PROFILE7_RPU, "base64"));
    run("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24000/1001:d=4", "-pix_fmt", "yuv420p10le", "-c:v", "libx265",
      "-x265-params", "log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", "-f", "hevc", "bl.hevc",
    ]);
    run(doviTool(), ["inject-rpu", "-i", "bl.hevc", "--rpu-in", "rpu.bin", "-o", "p7.hevc"]);
    run("mkvmerge", ["-q", "-o", "p7.mkv", "--default-duration", "0:24000/1001p", "p7.hevc"]);
    assert.equal(profile(path.join(root, "p7.mkv")), "7");
    const source = path.join(root, "Film.ts");
    run("ffmpeg", [
      "-v", "error", "-itsoffset", "0.5", "-i", "p7.mkv", "-f", "lavfi", "-i", "sine=d=4.5", "-f", "lavfi", "-i", "sine=f=880:d=4.5",
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "copy", "-c:a", "ac3", "-f", "mpegts", source,
    ]);
    const before = parseDoviProbe(
      run("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,start_time:format=duration", "-of", "json", source]).toString(),
    );
    assert.ok(videoDelayMs(before) >= 400);

    const steps: number[] = [];
    const message = await convertDolbyVision({ source, workDir: path.join(root, "work"), onProgress: (percent) => steps.push(percent) });
    assert.match(message, /Saved Film\.DV8\.mkv/);
    const target = path.join(root, "Film.DV8.mkv");
    assert.equal(profile(target), "8");
    assert.ok(fs.existsSync(source), "the source stays");
    assert.ok(!fs.existsSync(path.join(root, "work")), "scratch is cleaned up");
    assert.ok(steps.includes(96));

    await assert.rejects(convertDolbyVision({ source, workDir: path.join(root, "work"), onProgress: () => undefined }), /already exists/);
    assert.match(await convertDolbyVision({ source: target, workDir: path.join(root, "work"), onProgress: () => undefined }), /Nothing to convert/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function videoSpan(file: string): number {
  const times = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file])
    .toString()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => Number.parseFloat(line));
  return Math.max(...times) - Math.min(...times);
}

test("a TS with lost packets still converts, leaving the damaged frames out with the picture in sync", { skip: !hasTools() && "needs dovi_tool, mkvmerge, and ffmpeg with libx265" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-dovi-damaged-"));
  try {
    const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: root, stdio: "pipe" });
    fs.writeFileSync(path.join(root, "rpu.bin"), Buffer.from(PROFILE7_RPU, "base64"));
    run("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24000/1001:d=10", "-pix_fmt", "yuv420p10le", "-c:v", "libx265",
      "-x265-params", "log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", "-f", "hevc", "bl.hevc",
    ]);
    run(doviTool(), ["inject-rpu", "-i", "bl.hevc", "--rpu-in", "rpu.bin", "-o", "p7.hevc"]);
    run("mkvmerge", ["-q", "-o", "p7.mkv", "--default-duration", "0:24000/1001p", "p7.hevc"]);
    run("ffmpeg", ["-v", "error", "-i", "p7.mkv", "-f", "lavfi", "-i", "sine=d=10", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "ac3", "-f", "mpegts", "clean.ts"]);

    const packets = fs.readFileSync(path.join(root, "clean.ts"));
    const video: number[] = [];
    for (let at = 0; at + 188 <= packets.length; at += 188) {
      if ((((packets[at + 1]! & 0x1f) << 8) | packets[at + 2]!) === 0x100) video.push(at);
    }
    const lost = new Set(Array.from({ length: 30 }, (_, step) => video[Math.floor(video.length / 3) + step * 7]));
    const kept: Buffer[] = [];
    for (let at = 0; at + 188 <= packets.length; at += 188) if (!lost.has(at)) kept.push(packets.subarray(at, at + 188));
    const source = path.join(root, "Film.ts");
    fs.writeFileSync(source, Buffer.concat(kept));

    const message = await convertDolbyVision({ source, workDir: path.join(root, "work"), onProgress: () => undefined });
    assert.match(message, /Saved Film\.DV8\.mkv/);
    assert.match(message, /\d+ damaged frames in the file were left out/);
    const target = path.join(root, "Film.DV8.mkv");
    assert.equal(profile(target), "8");
    assert.ok(Math.abs(videoSpan(target) - videoSpan(path.join(root, "clean.ts"))) < 0.05, "the last frame plays at the same moment as in the source");
    assert.ok(fs.existsSync(source), "the source stays");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Dolby Vision packet damaged inside the video is replaced so the file still converts", { skip: !hasTools() && "needs dovi_tool, mkvmerge, and ffmpeg with libx265" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-dovi-rpu-"));
  try {
    const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: root, stdio: "pipe" });
    fs.writeFileSync(path.join(root, "rpu.bin"), Buffer.from(PROFILE7_RPU, "base64"));
    run("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24000/1001:d=4", "-pix_fmt", "yuv420p10le", "-c:v", "libx265",
      "-x265-params", "log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", "-f", "hevc", "bl.hevc",
    ]);
    run(doviTool(), ["inject-rpu", "-i", "bl.hevc", "--rpu-in", "rpu.bin", "-o", "p7.hevc"]);
    const stream = fs.readFileSync(path.join(root, "p7.hevc"));
    const marker = Buffer.from([0, 0, 1, 0x7c, 0x01]);
    let at = -1;
    for (let count = 0; count < 40; count += 1) at = stream.indexOf(marker, at + 1);
    const next = stream.indexOf(Buffer.from([0, 0, 1]), at + 3);
    let last = next - 1;
    while (stream[last] === 0) last -= 1;
    stream[last] = 200;
    fs.writeFileSync(path.join(root, "p7.hevc"), stream);
    const broken = spawnSync(doviTool(), ["-m", "2", "convert", "--discard", "p7.hevc", "-o", "plain.hevc"], { cwd: root });
    assert.match(broken.stderr.toString() + broken.stdout.toString(), /Invalid RPU last byte: 200/);

    run("mkvmerge", ["-q", "-o", "p7.mkv", "--default-duration", "0:24000/1001p", "p7.hevc"]);
    const source = path.join(root, "Film.ts");
    run("ffmpeg", ["-v", "error", "-i", "p7.mkv", "-f", "lavfi", "-i", "sine=d=4", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "ac3", "-f", "mpegts", source]);
    const message = await convertDolbyVision({ source, workDir: path.join(root, "work"), onProgress: () => undefined });
    assert.match(message, /1 unreadable Dolby Vision packet was replaced with the one from the frame before/);
    assert.equal(profile(path.join(root, "Film.DV8.mkv")), "8");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
