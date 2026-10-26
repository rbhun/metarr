import { runTool } from "@/lib/rewrap/tool";

const SAMPLE_FRAMES = 300;
const SAMPLE_TIMEOUT_MS = 5 * 60 * 1000;

export type FieldOrder = "tff" | "bff";

export type IdetCounts = { tff: number; bff: number; progressive: number; undetermined: number; repeated: number };

export type Interlace =
  | { kind: "progressive" | "unclear"; order: null; counts: IdetCounts }
  | { kind: "interlaced" | "telecined"; order: FieldOrder; counts: IdetCounts };

const EMPTY: IdetCounts = { tff: 0, bff: 0, progressive: 0, undetermined: 0, repeated: 0 };

/** The idet totals from `metadata=mode=print` lines; each frame repeats the running count, so the last one wins. */
export function parseIdet(lines: string[]): IdetCounts {
  const counts = { ...EMPTY };
  let top = 0;
  let bottom = 0;
  for (const line of lines) {
    const match = /^lavfi\.idet\.(multiple|repeated)\.(tff|bff|progressive|undetermined|top|bottom)=([\d.]+)$/.exec(line.trim());
    if (!match) continue;
    const value = Math.round(Number(match[3]));
    if (match[1] === "multiple") counts[match[2] as "tff" | "bff" | "progressive" | "undetermined"] = value;
    else if (match[2] === "top") top = value;
    else if (match[2] === "bottom") bottom = value;
  }
  return { ...counts, repeated: top + bottom };
}

export function addCounts(a: IdetCounts, b: IdetCounts): IdetCounts {
  return {
    tff: a.tff + b.tff,
    bff: a.bff + b.bff,
    progressive: a.progressive + b.progressive,
    undetermined: a.undetermined + b.undetermined,
    repeated: a.repeated + b.repeated,
  };
}

/**
 * Interlaced only when one field order clearly wins, so busy progressive footage that idet half-reads
 * as combed is left alone. 3:2 pulldown repeats a field in two of every five frames.
 */
export function classifyInterlace(counts: IdetCounts): Interlace {
  const total = counts.tff + counts.bff + counts.progressive + counts.undetermined;
  if (total < 50) return { kind: "unclear", order: null, counts };
  const combed = counts.tff + counts.bff;
  const order: FieldOrder = counts.bff > counts.tff ? "bff" : "tff";
  const winner = Math.max(counts.tff, counts.bff);
  const loser = Math.min(counts.tff, counts.bff);
  if (counts.repeated / total >= 0.15 && combed / total >= 0.2) return { kind: "telecined", order, counts };
  if (winner / total >= 0.6 && winner >= loser * 3) return { kind: "interlaced", order, counts };
  if (combed / total < 0.1) return { kind: "progressive", order: null, counts };
  return { kind: "unclear", order: null, counts };
}

/** The video filter for an encode, or null when the picture should be copied as it is. */
export function interlaceFilter(found: Interlace, force = false): string | null {
  if (found.kind === "telecined") return `fieldmatch=order=${found.order},bwdif=deint=interlaced,decimate,format=yuv420p`;
  if (found.kind === "interlaced") return `bwdif=mode=send_field:parity=${found.order}:deint=all,format=yuv420p`;
  const order: FieldOrder = found.counts.bff > found.counts.tff ? "bff" : "tff";
  return force ? `bwdif=mode=send_field:parity=${order}:deint=all,format=yuv420p` : null;
}

export function describeInterlace(found: Interlace): string {
  if (found.kind === "telecined") return "3:2 pulldown (telecined film)";
  if (found.kind === "interlaced") return `interlaced, ${found.order === "tff" ? "top" : "bottom"} field first`;
  if (found.kind === "progressive") return "progressive";
  return "not clearly interlaced";
}

/** Where to sample: three short stretches away from the opening titles and the credits. */
export function sampleStarts(duration: number | null): number[] {
  if (!duration || duration < 60) return [0];
  return [0.2, 0.5, 0.8].map((share) => Math.floor(duration * share));
}

/** Decodes a few hundred frames at a few points with ffmpeg's idet filter. Nothing is written. */
export async function detectInterlace(file: string, duration: number | null): Promise<Interlace> {
  let counts = { ...EMPTY };
  for (const start of sampleStarts(duration)) {
    const lines: string[] = [];
    await runTool(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        ...(start > 0 ? ["-ss", String(start)] : []),
        "-i", file,
        "-map", "0:v:0", "-an", "-sn",
        "-frames:v", String(SAMPLE_FRAMES),
        "-vf", "idet,metadata=mode=print:file=-",
        "-f", "null", "-",
      ],
      SAMPLE_TIMEOUT_MS,
      (line) => {
        if (line.startsWith("lavfi.idet.")) lines.push(line);
      },
    );
    counts = addCounts(counts, parseIdet(lines));
  }
  return classifyInterlace(counts);
}
