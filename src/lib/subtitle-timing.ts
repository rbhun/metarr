export type TimingFormat = "srt" | "vtt" | "ass";

/** A cue time change: every time becomes `time * scale + offset` (seconds). */
export type TimingMap = { scale: number; offset: number };

export type CueSpan = {
  cues: number;
  firstStart: number;
  firstText: string;
  lastEnd: number;
  lastText: string;
};

export type TimingPreset = { id: string; label: string; scale: number };

export type TimingStatus = "fits" | "longer" | "shorter" | "unknown";

export type TimingVerdict = { status: TimingStatus; message: string; preset: string | null };

const FILM = 24000 / 1001;

/** Subtitle times are multiplied by `scale`. A 25 fps subtitle on a 23.976 fps video has to be stretched. */
export const TIMING_PRESETS: TimingPreset[] = [
  { id: "pal-to-film", label: "Made for 25 fps, video is 23.976 fps (stretch 4.3%)", scale: 25 / FILM },
  { id: "pal-to-24", label: "Made for 25 fps, video is 24 fps (stretch 4.2%)", scale: 25 / 24 },
  { id: "film-to-pal", label: "Made for 23.976 fps, video is 25 fps (shrink 4.1%)", scale: FILM / 25 },
  { id: "24-to-pal", label: "Made for 24 fps, video is 25 fps (shrink 4%)", scale: 24 / 25 },
  { id: "24-to-film", label: "Made for 24 fps, video is 23.976 fps (stretch 0.1%)", scale: 24 / FILM },
  { id: "film-to-24", label: "Made for 23.976 fps, video is 24 fps (shrink 0.1%)", scale: FILM / 24 },
];

/** A last line this far past the video end is not rounding. */
const END_SLACK_SECONDS = 2;
/** Credits rarely take more than this share of a film, so a larger gap at the end hints at a 25 fps subtitle. */
const CREDITS_SHARE = 0.05;
/** A subtitle that stops this early is for another cut, not another frame rate. */
const OTHER_CUT_SHARE = 0.2;

export function timingFormat(file: string): TimingFormat | null {
  const match = /\.(srt|vtt|ass|ssa)$/i.exec(file);
  if (!match) return null;
  const ext = match[1]!.toLowerCase();
  return ext === "ssa" ? "ass" : (ext as TimingFormat);
}

const SRT_TIME = /(\d+):(\d{1,2}):(\d{1,2})([,.])(\d{1,3})/;
const VTT_TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})/;
const SRT_LINE = new RegExp(`^(\\s*)${SRT_TIME.source}(\\s*-->\\s*)${SRT_TIME.source}(.*)$`);
const VTT_LINE = new RegExp(`^(\\s*)${VTT_TIME.source}(\\s*-->\\s*)${VTT_TIME.source}(.*)$`);
const VTT_INLINE = new RegExp(`<${VTT_TIME.source}>`, "g");
const ASS_TIME = /^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/;

function fraction(digits: string): number {
  return Number(`0.${digits}`);
}

function srtSeconds(hours: string, minutes: string, seconds: string, part: string): number {
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + fraction(part);
}

function vttSeconds(hours: string | undefined, minutes: string, seconds: string, part: string): number {
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + fraction(part);
}

function assSeconds(value: string): number | null {
  const match = ASS_TIME.exec(value.trim());
  if (!match) return null;
  return srtSeconds(match[1]!, match[2]!, match[3]!, match[4]!);
}

function split(total: number, unit: number): { hours: number; minutes: number; seconds: number; part: number } {
  const ticks = Math.max(0, Math.round(total * unit));
  const whole = Math.floor(ticks / unit);
  return { hours: Math.floor(whole / 3600), minutes: Math.floor(whole / 60) % 60, seconds: whole % 60, part: ticks % unit };
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

function srtStamp(total: number, separator: string): string {
  const time = split(total, 1000);
  return `${pad(time.hours)}:${pad(time.minutes)}:${pad(time.seconds)}${separator}${pad(time.part, 3)}`;
}

function vttStamp(total: number, withHours: boolean): string {
  const time = split(total, 1000);
  const tail = `${pad(time.minutes)}:${pad(time.seconds)}.${pad(time.part, 3)}`;
  return withHours || time.hours > 0 ? `${pad(time.hours)}:${tail}` : tail;
}

function assStamp(total: number): string {
  const time = split(total, 100);
  return `${time.hours}:${pad(time.minutes)}:${pad(time.seconds)}.${pad(time.part)}`;
}

function apply(map: TimingMap, seconds: number): number {
  return Math.max(0, seconds * map.scale + map.offset);
}

function plainText(value: string): string {
  return value
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\[Nn]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Cue = { start: number; end: number; text: string };

function lines(raw: string): string[] {
  return raw.replace(/^\uFEFF/, "").split(/\r?\n|\r/);
}

function blockCues(raw: string, line: RegExp, read: (match: RegExpExecArray) => { start: number; end: number }): Cue[] {
  const all = lines(raw);
  const cues: Cue[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const match = line.exec(all[index]!);
    if (!match) continue;
    const text: string[] = [];
    for (let next = index + 1; next < all.length && all[next]!.trim() && !line.test(all[next]!); next += 1) text.push(all[next]!);
    cues.push({ ...read(match), text: plainText(text.join(" ")) });
  }
  return cues;
}

type AssFields = { start: number; end: number; text: number; count: number };

function assFields(format: string | undefined): AssFields {
  const names = (format ?? "").split(",").map((name) => name.trim().toLowerCase());
  const start = names.indexOf("start");
  const end = names.indexOf("end");
  const text = names.indexOf("text");
  if (start < 0 || end < 0 || text < 0) return { start: 1, end: 2, text: 9, count: 10 };
  return { start, end, text, count: names.length };
}

/** `Dialogue:` and `Comment:` lines in `[Events]`, with the column order from that section's `Format:` line. */
function assEvents(all: string[], visit: (line: string, fields: AssFields, kind: string, values: string[]) => string | void): string[] {
  let fields = assFields(undefined);
  let inEvents = false;
  return all.map((line) => {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) inEvents = /^\[events\]$/i.test(trimmed);
    if (!inEvents) return line;
    const format = /^Format:(.*)$/i.exec(trimmed);
    if (format) {
      fields = assFields(format[1]);
      return line;
    }
    const event = /^(\s*)(Dialogue|Comment):(\s*)(.*)$/i.exec(line);
    if (!event) return line;
    const parts = event[4]!.split(",");
    const values = [...parts.slice(0, fields.count - 1), parts.slice(fields.count - 1).join(",")];
    const changed = visit(line, fields, event[2]!, values);
    return changed == null ? line : `${event[1]}${event[2]}:${event[3]}${changed}`;
  });
}

function assCues(raw: string): Cue[] {
  const cues: Cue[] = [];
  assEvents(lines(raw), (_line, fields, kind, values) => {
    if (kind.toLowerCase() !== "dialogue") return;
    const start = assSeconds(values[fields.start] ?? "");
    const end = assSeconds(values[fields.end] ?? "");
    if (start == null || end == null) return;
    cues.push({ start, end, text: plainText(values[fields.text] ?? "") });
  });
  return cues;
}

function cuesOf(raw: string, format: TimingFormat): Cue[] {
  if (format === "ass") return assCues(raw);
  if (format === "vtt") {
    return blockCues(raw, VTT_LINE, (match) => ({
      start: vttSeconds(match[2], match[3]!, match[4]!, match[5]!),
      end: vttSeconds(match[7], match[8]!, match[9]!, match[10]!),
    }));
  }
  return blockCues(raw, SRT_LINE, (match) => ({
    start: srtSeconds(match[2]!, match[3]!, match[4]!, match[6]!),
    end: srtSeconds(match[8]!, match[9]!, match[10]!, match[12]!),
  }));
}

/** The earliest and latest cue, or null when the file has no timed lines. */
export function cueSpan(raw: string, format: TimingFormat): CueSpan | null {
  const cues = cuesOf(raw, format);
  if (!cues.length) return null;
  let first = cues[0]!;
  let last = cues[0]!;
  for (const cue of cues) {
    if (cue.start < first.start) first = cue;
    if (cue.end > last.end) last = cue;
  }
  return { cues: cues.length, firstStart: first.start, firstText: first.text, lastEnd: last.end, lastText: last.text };
}

/** Move every cue time. Only the timestamps change; the rest of the file, including its line endings, stays byte for byte. */
export function retime(raw: string, format: TimingFormat, map: TimingMap): string {
  const parts = raw.split(/(\r?\n|\r)/);
  if (format === "ass") {
    return assEvents(parts, (_line, fields, _kind, values) => {
      const start = assSeconds(values[fields.start] ?? "");
      const end = assSeconds(values[fields.end] ?? "");
      if (start == null || end == null) return;
      const next = [...values];
      next[fields.start] = assStamp(apply(map, start));
      next[fields.end] = assStamp(apply(map, end));
      return next.join(",");
    }).join("");
  }
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    if (format === "srt") {
      parts[index] = line.replace(SRT_LINE, (_all, lead, h1, m1, s1, sep1, f1, arrow, h2, m2, s2, sep2, f2, rest) =>
        `${lead}${srtStamp(apply(map, srtSeconds(h1, m1, s1, f1)), sep1)}${arrow}${srtStamp(apply(map, srtSeconds(h2, m2, s2, f2)), sep2)}${rest}`,
      );
      continue;
    }
    const cue = line.replace(VTT_LINE, (_all, lead, h1, m1, s1, f1, arrow, h2, m2, s2, f2, rest) =>
      `${lead}${vttStamp(apply(map, vttSeconds(h1, m1, s1, f1)), h1 != null)}${arrow}${vttStamp(apply(map, vttSeconds(h2, m2, s2, f2)), h2 != null)}${rest}`,
    );
    parts[index] = cue === line ? line.replace(VTT_INLINE, (_all, h, m, s, f) => `<${vttStamp(apply(map, vttSeconds(h, m, s, f)), h != null)}>`) : cue;
  }
  return parts.join("");
}

/** The change that moves `fromFirst` to `toFirst` and `fromLast` to `toLast`. */
export function twoPointMap(fromFirst: number, toFirst: number, fromLast: number, toLast: number): TimingMap | null {
  if (![fromFirst, toFirst, fromLast, toLast].every(Number.isFinite)) return null;
  if (fromLast - fromFirst < 1 || toLast - toFirst < 1) return null;
  const scale = (toLast - toFirst) / (fromLast - fromFirst);
  return { scale, offset: toFirst - fromFirst * scale };
}

export function isIdentity(map: TimingMap): boolean {
  return Math.abs(map.scale - 1) < 1e-6 && Math.abs(map.offset) < 0.0005;
}

/** Refuse a change that is clearly a typo rather than a frame rate or a shift. */
export function timingMapProblem(map: TimingMap): string | null {
  if (!Number.isFinite(map.scale) || !Number.isFinite(map.offset)) return "The new times are not numbers.";
  if (map.scale < 0.5 || map.scale > 2) return "That would stretch or shrink the subtitle by more than half.";
  if (Math.abs(map.offset) > 6 * 3600) return "That would shift the subtitle by more than six hours.";
  return null;
}

type FpsFamily = "film" | "pal" | "other" | null;

function fpsFamily(fps: number | null): FpsFamily {
  if (fps == null || !Number.isFinite(fps)) return null;
  if (Math.abs(fps - 25) < 0.1) return "pal";
  if (fps > 23.9 && fps < 24.1) return "film";
  return "other";
}

/** After an automatic fix the last line has to land this close to the video end. */
export const CLEAR_FIX_SECONDS = 10;

/** The frame rate a preset says the video has. */
const PRESET_VIDEO_FPS: Record<string, number> = {
  "film-to-pal": 25,
  "24-to-pal": 25,
  "film-to-24": 24,
  "pal-to-film": FILM,
  "pal-to-24": 24,
  "24-to-film": FILM,
};

/**
 * A fix Metarr may apply without asking: the subtitle runs past the video, the video's own frame
 * rate is the one the preset expects, the length was measured, and after the change the last line
 * ends within a few seconds of the video. A subtitle that stops early is never fixed on its own,
 * because long credits look the same.
 */
export function isClearFix(input: {
  status: TimingStatus;
  preset: string | null;
  lastEnd: number | null;
  videoSeconds: number | null;
  fps: number | null;
  measured: boolean;
  retimed: boolean;
}): boolean {
  if (input.status !== "longer" || !input.preset || input.retimed || !input.measured) return false;
  if (input.lastEnd == null || input.videoSeconds == null || input.fps == null) return false;
  const expected = PRESET_VIDEO_FPS[input.preset];
  const scale = TIMING_PRESETS.find((item) => item.id === input.preset)?.scale;
  if (expected == null || scale == null || Math.abs(input.fps - expected) > 0.01) return false;
  return Math.abs(input.lastEnd * scale - input.videoSeconds) <= CLEAR_FIX_SECONDS;
}

export function presetScale(id: string | null): number | null {
  return TIMING_PRESETS.find((item) => item.id === id)?.scale ?? null;
}

export function formatClock(seconds: number): string {
  const time = split(seconds, 1000);
  return `${time.hours}:${pad(time.minutes)}:${pad(time.seconds)}.${pad(time.part, 3)}`;
}

/** `1:52:03.120`, `52:03`, `3123.5` and `1:52:03,120` all read as seconds. */
export function parseClock(text: string): number | null {
  const value = text.trim().replace(",", ".");
  if (!value) return null;
  const match = /^(?:(?:(\d+):)?(\d{1,2}):)?(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3]);
  if ((match[2] != null && seconds >= 60) || (match[1] != null && minutes >= 60)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function minutesText(seconds: number): string {
  const minutes = Math.abs(seconds) / 60;
  if (minutes < 1) return `${Math.round(Math.abs(seconds))} s`;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`;
}

function preset(id: string): TimingPreset {
  return TIMING_PRESETS.find((item) => item.id === id)!;
}

/** Whether the subtitle runs past the video, or stops so early that a 25 fps subtitle on a film-rate video is likely. */
export function judgeTiming(span: CueSpan, videoSeconds: number | null, fps: number | null): TimingVerdict {
  if (videoSeconds == null || videoSeconds <= 0) {
    return { status: "unknown", message: "The video length could not be read, so the subtitle cannot be compared with it.", preset: null };
  }
  const family = fpsFamily(fps);
  const over = span.lastEnd - videoSeconds;
  if (over > END_SLACK_SECONDS) {
    const order = family === "pal" ? ["film-to-pal", "24-to-pal"] : family === "film" ? ["film-to-24", "film-to-pal"] : ["film-to-24", "film-to-pal", "24-to-pal"];
    const fit = order.find((id) => span.lastEnd * preset(id).scale <= videoSeconds + END_SLACK_SECONDS) ?? null;
    const share = ((span.lastEnd / videoSeconds - 1) * 100).toFixed(1);
    const why = fit
      ? fit === "film-to-24"
        ? "That matches a 23.976 fps subtitle on a 24 fps video."
        : "That matches a subtitle made for a film-rate copy on a 25 fps video."
      : "That is more than a frame rate change explains, so it is probably for a different cut. Line up the first and last line by hand.";
    return { status: "longer", message: `The last line ends ${minutesText(over)} after the video ends (${share}% longer). ${why}`, preset: fit };
  }
  const gap = videoSeconds - span.lastEnd;
  if (gap / videoSeconds > OTHER_CUT_SHARE) {
    return {
      status: "shorter",
      message: `The last line is ${minutesText(gap)} before the video ends. That is more than credits or a frame rate change explain, so it may be for a shorter cut.`,
      preset: null,
    };
  }
  const stretch = preset("pal-to-film");
  if (family !== "pal" && family !== "other" && gap / videoSeconds > CREDITS_SHARE && span.lastEnd * stretch.scale <= videoSeconds + END_SLACK_SECONDS) {
    return {
      status: "shorter",
      message: `The last line is ${minutesText(gap)} before the video ends. Long credits could explain that, but it also matches a 25 fps subtitle on a 23.976 fps video. Compare the last line with the video before you apply.`,
      preset: stretch.id,
    };
  }
  return {
    status: "fits",
    message: gap > END_SLACK_SECONDS ? `The last line is ${minutesText(gap)} before the video ends, which the credits explain.` : "The last line ends with the video.",
    preset: null,
  };
}
