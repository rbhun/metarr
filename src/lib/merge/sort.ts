export type FrameMatchNote = {
  ok?: boolean;
  percent?: number;
};

/** Higher match percent first; unchecked pairs stay at the bottom. */
export function frameMatchRank(note: FrameMatchNote | undefined): number {
  if (!note || typeof note.percent !== "number" || !Number.isFinite(note.percent)) return -1;
  return note.percent;
}

export function sortMergeCandidates<T extends { key: string; label?: string; left: { name: string } }>(
  candidates: readonly T[],
  frames: Record<string, FrameMatchNote | undefined>,
): T[] {
  return [...candidates].sort((a, b) => {
    const byMatch = frameMatchRank(frames[b.key]) - frameMatchRank(frames[a.key]);
    if (byMatch !== 0) return byMatch;
    const byLabel = (a.label ?? "").localeCompare(b.label ?? "", undefined, { sensitivity: "base" });
    if (byLabel !== 0) return byLabel;
    return a.left.name.localeCompare(b.left.name);
  });
}
