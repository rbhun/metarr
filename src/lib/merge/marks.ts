import { resolutionRank } from "@/lib/media";

export type FieldMark = "better" | "worse" | "differ" | null;

function fpsNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const fps = Number(match[1]);
  return Number.isFinite(fps) && fps > 0 && fps < 120 ? fps : null;
}

export function formatVersionFps(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return /fps/i.test(value) ? value.trim() : `${value.trim()} fps`;
}

export function markResolution(self: string | null | undefined, other: string | null | undefined): FieldMark {
  const left = resolutionRank(self ?? null);
  const right = resolutionRank(other ?? null);
  if (!left && !right) return null;
  if (left === right) return null;
  if (!right) return "better";
  if (!left) return "worse";
  return left > right ? "better" : "worse";
}

export function markBitrate(self: number | null | undefined, other: number | null | undefined): FieldMark {
  const left = self != null && self > 0 ? self : 0;
  const right = other != null && other > 0 ? other : 0;
  if (!left && !right) return null;
  if (left === right) return null;
  if (!right) return "better";
  if (!left) return "worse";
  return left > right ? "better" : "worse";
}

/** Frame rate is not a quality score: a mismatch is only a difference. */
export function markFrameRate(self: string | null | undefined, other: string | null | undefined): FieldMark {
  const left = fpsNumber(self);
  const right = fpsNumber(other);
  if (left == null && right == null) return null;
  if (left == null || right == null) return "differ";
  return Math.abs(left - right) < 0.08 ? null : "differ";
}

export function markIfDifferent(self: string | null | undefined, other: string | null | undefined): FieldMark {
  const left = self?.trim() || "";
  const right = other?.trim() || "";
  if (!left && !right) return null;
  if (left.toLowerCase() === right.toLowerCase()) return null;
  return "differ";
}

export function markClass(mark: FieldMark): string {
  if (mark === "better") return "text-emerald-700 dark:text-emerald-400";
  if (mark === "worse" || mark === "differ") return "text-red-600 dark:text-red-400";
  return "";
}
