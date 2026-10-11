import assert from "node:assert/strict";
import test from "node:test";
import { originalPath, subtitleText } from "@/lib/subtitle-fix";
import {
  cueSpan,
  formatClock,
  judgeTiming,
  parseClock,
  retime,
  TIMING_PRESETS,
  timingFormat,
  timingMapProblem,
  twoPointMap,
  type CueSpan,
} from "@/lib/subtitle-timing";

const srt = "\uFEFF1\r\n00:00:10,000 --> 00:00:12,500\r\n<i>Hello</i> there\r\n\r\n2\r\n01:40:00,000 --> 01:40:04,000 X1:10\r\nGoodbye\r\n";

const scale = (id: string) => TIMING_PRESETS.find((item) => item.id === id)!.scale;

test("timingFormat accepts text subtitles only", () => {
  assert.equal(timingFormat("Film.hun.srt"), "srt");
  assert.equal(timingFormat("Film.en.SSA"), "ass");
  assert.equal(timingFormat("Film.vtt"), "vtt");
  assert.equal(timingFormat("Film.idx"), null);
  assert.equal(timingFormat("Film.sub"), null);
});

test("cueSpan finds the first and last line of an SRT", () => {
  const span = cueSpan(srt, "srt");
  assert.deepEqual(span, { cues: 2, firstStart: 10, firstText: "Hello there", lastEnd: 6004, lastText: "Goodbye" });
});

test("retime changes only the SRT timestamps and keeps CRLF, BOM and cue settings", () => {
  const next = retime(srt, "srt", { scale: 2, offset: 1 });
  assert.equal(next, "\uFEFF1\r\n00:00:21,000 --> 00:00:26,000\r\n<i>Hello</i> there\r\n\r\n2\r\n03:20:01,000 --> 03:20:09,000 X1:10\r\nGoodbye\r\n");
});

test("retime clamps a time pushed before zero", () => {
  const next = retime("1\n00:00:01,000 --> 00:00:03,000\nHi\n", "srt", { scale: 1, offset: -2 });
  assert.match(next, /00:00:00,000 --> 00:00:01,000/);
});

test("WebVTT keeps short times short and moves inline timestamps", () => {
  const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nOne <00:01.500>two\n\n01:00:00.000 --> 01:00:01.000\nEnd\n";
  assert.equal(cueSpan(vtt, "vtt")?.lastEnd, 3601);
  const next = retime(vtt, "vtt", { scale: 1, offset: 10 });
  assert.equal(next, "WEBVTT\n\n00:11.000 --> 00:12.000 align:start\nOne <00:11.500>two\n\n01:00:10.000 --> 01:00:11.000\nEnd\n");
});

test("ASS uses the Format line and leaves commas in the text alone", () => {
  const ass = [
    "[Script Info]",
    "Title: x",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname",
    "Style: Default,Arial",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,{\\i1}Well, hello\\Nthere",
    "Comment: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,note",
    "Dialogue: 0,1:00:00.00,1:00:02.00,Default,,0,0,0,,Bye",
    "",
  ].join("\r\n");
  const span = cueSpan(ass, "ass");
  assert.deepEqual(span, { cues: 2, firstStart: 5, firstText: "Well, hello there", lastEnd: 3602, lastText: "Bye" });
  const next = retime(ass, "ass", { scale: 1, offset: 0.25 });
  assert.match(next, /\r\nDialogue: 0,0:00:05\.25,0:00:07\.75,Default,,0,0,0,,\{\\i1\}Well, hello\\Nthere\r\n/);
  assert.match(next, /\r\nComment: 0,0:00:08\.25,0:00:09\.25,/);
  assert.match(next, /\r\nDialogue: 0,1:00:00\.25,1:00:02\.25,/);
  assert.match(next, /Style: Default,Arial/);
});

test("a PAL stretch moves a 25 fps subtitle onto a film-rate video", () => {
  const next = retime("1\n01:00:00,000 --> 01:00:02,000\nX\n", "srt", { scale: scale("pal-to-film"), offset: 0 });
  assert.match(next, /01:02:33,750 --> 01:02:35,835/);
});

function span(lastEnd: number, firstStart = 60): CueSpan {
  return { cues: 1000, firstStart, firstText: "a", lastEnd, lastText: "b" };
}

test("judgeTiming calls a film subtitle on a 25 fps video longer and offers the shrink", () => {
  const video = 6000;
  const verdict = judgeTiming(span(video * (25 / (24000 / 1001)) - 120), video, 25);
  assert.equal(verdict.status, "longer");
  assert.equal(verdict.preset, "film-to-pal");
});

test("judgeTiming offers no preset when the subtitle is far too long for a frame rate change", () => {
  const verdict = judgeTiming(span(7200), 6000, 23.976);
  assert.equal(verdict.status, "longer");
  assert.equal(verdict.preset, null);
});

test("judgeTiming suggests the PAL stretch when a film-rate video outlasts the subtitle by more than credits", () => {
  const video = 6000;
  const verdict = judgeTiming(span((video - 60) / (25 / (24000 / 1001))), video, 23.976);
  assert.equal(verdict.status, "shorter");
  assert.equal(verdict.preset, "pal-to-film");
});

test("judgeTiming accepts a subtitle that stops for normal credits", () => {
  assert.equal(judgeTiming(span(6000 - 180), 6000, 23.976).status, "fits");
  assert.equal(judgeTiming(span(6000 - 400), 6000, 25).status, "fits");
  assert.equal(judgeTiming(span(5999), 6000, null).status, "fits");
  assert.equal(judgeTiming(span(5000), null, null).status, "unknown");
});

test("judgeTiming calls a subtitle for a much shorter cut shorter, with no preset", () => {
  const verdict = judgeTiming(span(4000), 6000, 23.976);
  assert.equal(verdict.status, "shorter");
  assert.equal(verdict.preset, null);
});

test("twoPointMap lines up the first and last line", () => {
  const map = twoPointMap(10, 12, 110, 212)!;
  assert.equal(map.scale, 2);
  assert.equal(map.offset, -8);
  assert.equal(twoPointMap(10, 12, 10.5, 30), null);
  assert.equal(timingMapProblem({ scale: 3, offset: 0 }) != null, true);
  assert.equal(timingMapProblem({ scale: 1.04, offset: -2 }), null);
});

test("clock text reads and writes hours, minutes and milliseconds", () => {
  assert.equal(formatClock(6723.12), "1:52:03.120");
  assert.equal(parseClock("1:52:03.120"), 6723.12);
  assert.equal(parseClock("52:03,5"), 3123.5);
  assert.equal(parseClock("90.25"), 90.25);
  assert.equal(parseClock("1:75:00"), null);
  assert.equal(parseClock("abc"), null);
});

test("subtitleText keeps non-UTF-8 bytes and UTF-16 intact across a retime", () => {
  const cp1250 = Buffer.concat([Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n"), Buffer.from([0x9a, 0xe8, 0xf8]), Buffer.from("\n")]);
  const latin = subtitleText(cp1250);
  const moved = latin.encode(retime(latin.text, "srt", { scale: 1, offset: 1 }));
  assert.deepEqual([...moved.subarray(moved.length - 4)], [0x9a, 0xe8, 0xf8, 0x0a]);
  assert.match(moved.toString("latin1"), /00:00:02,000 --> 00:00:03,000/);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("1\r\n00:00:01,000 --> 00:00:02,000\r\nŐr\r\n", "utf16le")]);
  const wide = subtitleText(utf16);
  const back = wide.encode(retime(wide.text, "srt", { scale: 1, offset: 1 }));
  assert.deepEqual([...back.subarray(0, 2)], [0xff, 0xfe]);
  assert.match(back.subarray(2).toString("utf16le"), /00:00:02,000 --> 00:00:03,000\r\nŐr/);

  const be = Buffer.from(utf16).swap16();
  const big = subtitleText(be);
  assert.deepEqual([...big.encode(big.text)], [...be]);
  assert.equal(originalPath("/m/Film.hun.srt"), "/m/Film.hun.srt.metarr-orig");
});
