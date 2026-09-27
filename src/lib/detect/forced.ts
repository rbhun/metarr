/**
 * A feature with only a few cues is translating signs and titles.
 * A full dialogue subtitle has hundreds of cues.
 */
export function isForcedCueCount(cues: number, durationSeconds: number | null): boolean {
  if (cues < 1 || cues > 40) return false;
  if (durationSeconds == null) return true;
  return durationSeconds >= 20 * 60;
}
