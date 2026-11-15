import fs from "node:fs";
import type { DoviStream } from "@/lib/dovi/run";

/** Audio Apple's player decodes from an MP4. TrueHD, DTS, FLAC and PCM are left in the original. */
const APPLE_AUDIO = new Set(["aac", "ac3", "eac3", "alac", "mp3"]);
/** Text subtitles become mov_text; picture subtitles (PGS, VobSub) cannot go into an MP4 Apple plays. */
const TEXT_SUBTITLES = new Set(["subrip", "ass", "ssa", "webvtt", "mov_text", "text"]);

export type Mp4Plan = {
  args: string[];
  audio: number;
  convertedAudio: string | null;
  droppedAudio: string[];
  subtitles: number;
  droppedSubtitles: number;
};

/**
 * Which streams go into the Apple MP4, and how. Video and Apple-playable audio are copied, text
 * subtitles become mov_text. When no audio track can be copied, the first one is converted to
 * E-AC3, so the film is never silent.
 */
export function planMp4(streams: DoviStream[], videoIndex: number): Mp4Plan {
  const audio = streams.filter((stream) => stream.type === "audio");
  const subtitles = streams.filter((stream) => stream.type === "subtitle");
  const copied = audio.filter((stream) => APPLE_AUDIO.has(stream.codec ?? ""));
  const text = subtitles.filter((stream) => TEXT_SUBTITLES.has(stream.codec ?? ""));
  const args = ["-map", `0:${videoIndex}`];
  let convertedAudio: string | null = null;
  if (copied.length) {
    for (const stream of copied) args.push("-map", `0:${stream.index}`);
    args.push("-c:a", "copy");
  } else if (audio[0]) {
    args.push("-map", `0:${audio[0].index}`, "-c:a", "eac3", "-b:a", "640k");
    if ((audio[0].channels ?? 0) > 6) args.push("-ac", "6");
    convertedAudio = audio[0].codec ?? "audio";
  }
  for (const stream of text) args.push("-map", `0:${stream.index}`);
  if (text.length) args.push("-c:s", "mov_text");
  if (copied.length || audio[0]) args.push("-disposition:a:0", "default");
  return {
    args,
    audio: copied.length || (audio[0] ? 1 : 0),
    convertedAudio,
    droppedAudio: (copied.length ? audio.filter((stream) => !copied.includes(stream)) : audio.slice(1)).map((stream) => stream.codec ?? "audio"),
    subtitles: text.length,
    droppedSubtitles: subtitles.length - text.length,
  };
}

type Box = { type: string; start: number; body: number; end: number };

function boxes(data: Buffer, from: number, to: number): Box[] {
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = data.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(data.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    found.push({ type: data.toString("latin1", at + 4, at + 8), start: at, body: at + header, end: at + size });
    at += size;
  }
  return found;
}

function child(data: Buffer, parent: Box, type: string): Box | undefined {
  return boxes(data, parent.body, parent.end).find((box) => box.type === type);
}

/** Where the top-level moov box sits in the file, read from the box headers only. */
function findMoov(fd: number, fileSize: number): { start: number; size: number } | null {
  const header = Buffer.alloc(16);
  let at = 0;
  while (at + 8 <= fileSize) {
    fs.readSync(fd, header, 0, 16, at);
    let size = header.readUInt32BE(0);
    if (size === 1) size = Number(header.readBigUInt64BE(8));
    else if (size === 0) size = fileSize - at;
    if (size < 8) return null;
    if (header.toString("latin1", 4, 8) === "moov") return { start: at, size };
    at += size;
  }
  return null;
}

/**
 * Apple's player wants Dolby Vision HEVC in an MP4 tagged `dvh1`. Debian's ffmpeg 5.1 only writes
 * `hvc1`, whose layout is the same, so the four bytes of the video sample entry are renamed in place.
 * Returns the tag the video track had.
 */
export function tagDvh1(file: string): string {
  const fd = fs.openSync(file, "r+");
  try {
    const moov = findMoov(fd, fs.fstatSync(fd).size);
    if (!moov || moov.size > 512 * 1024 * 1024) throw new Error("The MP4 has no readable index (moov box).");
    const data = Buffer.alloc(moov.size);
    fs.readSync(fd, data, 0, moov.size, moov.start);
    const root: Box = { type: "moov", start: 0, body: 8, end: moov.size };
    for (const trak of boxes(data, root.body, root.end).filter((box) => box.type === "trak")) {
      const mdia = child(data, trak, "mdia");
      const hdlr = mdia && child(data, mdia, "hdlr");
      if (!mdia || !hdlr || data.toString("latin1", hdlr.body + 8, hdlr.body + 12) !== "vide") continue;
      const stbl = child(data, child(data, mdia, "minf") ?? mdia, "stbl");
      const stsd = stbl && child(data, stbl, "stsd");
      if (!stsd) continue;
      const entry = stsd.body + 8;
      const tag = data.toString("latin1", entry + 4, entry + 8);
      if (tag === "hvc1") fs.writeSync(fd, Buffer.from("dvh1", "latin1"), 0, 4, moov.start + entry + 4);
      else if (tag !== "dvh1") throw new Error(`The MP4's video is tagged ${tag}, not hvc1.`);
      fs.fsyncSync(fd);
      return tag;
    }
    throw new Error("The MP4 has no video track.");
  } finally {
    fs.closeSync(fd);
  }
}
