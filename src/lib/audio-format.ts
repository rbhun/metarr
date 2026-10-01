import type { AudioTrack } from "@/lib/types";

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function channelLayout(count: number): string | null {
  if (count === 1) return "1.0";
  if (count === 2) return "2.0";
  if (count === 3) return "2.1";
  if (count === 4) return "3.1";
  if (count === 5) return "5.0";
  if (count === 6) return "5.1";
  if (count === 7) return "6.1";
  if (count === 8) return "7.1";
  if (count === 10) return "7.1.2";
  if (count === 12) return "7.1.4";
  if (Number.isFinite(count) && count > 0) return `${count}.0`;
  return null;
}

/** Channel count from a stream, as 2.0 or 5.1. */
export function audioLayoutLabel(channels: unknown, layout: unknown, title: unknown): string | null {
  const named = textOf(layout);
  if (named) {
    const found = named.match(/\d\.\d(?:\.\d)?/);
    if (found) return found[0];
    if (/stereo/i.test(named)) return "2.0";
    if (/mono/i.test(named)) return "1.0";
  }
  const count = typeof channels === "number" ? channels : typeof channels === "string" ? Number(channels) : NaN;
  const fromCount = channelLayout(count);
  if (fromCount) return fromCount;
  const label = textOf(title) ?? "";
  const fromTitle = label.match(/\b(\d\.\d(?:\.\d)?)\b/);
  if (fromTitle?.[1]) return fromTitle[1];
  if (/stereo/i.test(label)) return "2.0";
  if (/\bmono\b/i.test(label)) return "1.0";
  return null;
}

/** Codec name from a stream, in the same words the library uses for Plex. */
export function audioCodecLabel(codec: unknown, profile: unknown, title: unknown): string | null {
  const blob = [codec, profile, title].map(textOf).filter(Boolean).join(" ");
  if (!blob) return null;
  if (/atmos/i.test(blob)) return "Dolby Atmos";
  if (/truehd/i.test(blob)) return "Dolby TrueHD";
  if (/eac3|e-ac-3|digital plus/i.test(blob)) return "Dolby Digital Plus";
  if (/\bdts-hd\b|\bdts:x\b|\bdts hd\b/i.test(blob)) return "DTS-HD";
  if (/\bdts\b|\bdca\b/i.test(blob)) return "DTS";
  if (/ac3|ac-3|dolby digital/i.test(blob)) return "Dolby Digital";
  if (/\baac\b/i.test(blob)) return "AAC";
  if (/flac/i.test(blob)) return "FLAC";
  if (/opus/i.test(blob)) return "Opus";
  if (/mp3/i.test(blob)) return "MP3";
  if (/pcm/i.test(blob)) return "PCM";
  return null;
}

export function canonicalLayout(layout: string | null | undefined): string | null {
  if (!layout) return null;
  const found = layout.match(/\d\.\d(?:\.\d)?/);
  if (found) return found[0];
  if (/stereo/i.test(layout)) return "2.0";
  if (/mono/i.test(layout)) return "1.0";
  return layout;
}

export function canonicalCodec(codec: string | null | undefined): string | null {
  if (!codec) return null;
  return audioCodecLabel(codec, null, null) ?? codec;
}

/** What the file says when it disagrees with the format already stored for this track. */
export function audioFormatConflict(
  report: { layout: string | null; codec: string | null },
  scan: { layout: string | null; codec: string | null },
): string | null {
  const fileLayout = canonicalLayout(scan.layout);
  const keptLayout = canonicalLayout(report.layout);
  const fileCodec = canonicalCodec(scan.codec);
  const keptCodec = canonicalCodec(report.codec);
  const layoutDiffers = Boolean(fileLayout && keptLayout && fileLayout !== keptLayout);
  const codecDiffers = Boolean(fileCodec && keptCodec && fileCodec !== keptCodec);
  if (!layoutDiffers && !codecDiffers) return null;
  const fileText = [codecDiffers ? fileCodec : null, layoutDiffers ? fileLayout : null].filter(Boolean).join(" ");
  const keptText = [codecDiffers ? keptCodec : null, layoutDiffers ? keptLayout : null].filter(Boolean).join(" ");
  return `The file is ${fileText}. Plex says ${keptText}.`;
}

/** True when a probed track has a format the stored track does not. */
export function formatGaps(reported: AudioTrack[], scanned: AudioTrack[]): boolean {
  return scanned
    .filter((scan) => !scan.file)
    .some((scan, index) => {
      const report = reported[index];
      const missingLayout = Boolean(scan.layout) && !report?.layout;
      const missingCodec = Boolean(scan.codec) && !report?.codec;
      return missingLayout || missingCodec;
    });
}
