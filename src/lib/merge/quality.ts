import { hdrRank, resolutionRank } from "@/lib/media";
import type { HdrLabel } from "@/lib/types";

export type QualityInput = {
  resolution: string | null;
  bitrateKbps: number | null;
  fileBytes: number | null;
  hdr: HdrLabel;
};

/** Higher resolution wins, then bitrate, then file size, then HDR. */
export function qualityScore(file: QualityInput): number {
  const bitrate = file.bitrateKbps && file.bitrateKbps > 0 ? Math.min(file.bitrateKbps, 200_000) : 0;
  const bytes = file.fileBytes && file.fileBytes > 0 ? Math.min(file.fileBytes / 1_000_000, 200_000) : 0;
  return resolutionRank(file.resolution) * 1_000_000 + bitrate * 10 + bytes + hdrRank(file.hdr);
}

export function pickVideoSource<T extends QualityInput>(left: T, right: T): "left" | "right" {
  return qualityScore(right) > qualityScore(left) ? "right" : "left";
}
