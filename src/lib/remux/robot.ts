export type DiscTitle = {
  index: number;
  seconds: number;
  outputName: string | null;
  /** Size MakeMKV expects for the title (attribute 11), 0 when not given. */
  bytes: number;
  /** Playlist or stream file the title comes from (attribute 16), e.g. 00800.mpls. */
  sourceFile: string | null;
};

function durationSeconds(value: string): number {
  const parts = value.split(":").map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3) return 0;
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/** Titles from `makemkvcon --robot info`. Duration is attribute 9, size 11, source file 16, output name 27. */
export function parseDiscTitles(output: string): DiscTitle[] {
  const titles = new Map<number, DiscTitle>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^TINFO:(\d+),(\d+),\d+,(?:"([^"]*)"|(\S+))\s*$/.exec(line.trim());
    if (!match) continue;
    const index = Number(match[1]);
    const attribute = Number(match[2]);
    const value = match[3] ?? match[4] ?? "";
    const title = titles.get(index) ?? { index, seconds: 0, outputName: null, bytes: 0, sourceFile: null };
    if (attribute === 9) title.seconds = durationSeconds(value);
    if (attribute === 11 && /^\d+$/.test(value)) title.bytes = Number(value);
    if (attribute === 16 && value) title.sourceFile = value;
    if (attribute === 27 && value) title.outputName = value;
    titles.set(index, title);
  }
  return [...titles.values()].filter((title) => title.seconds > 0);
}

function better(title: DiscTitle, best: DiscTitle): boolean {
  if (title.bytes !== best.bytes) return title.bytes > best.bytes;
  return title.seconds > best.seconds;
}

/**
 * The feature is the largest title. Duration alone is not enough: on discs with
 * hundreds of clips a stray clip can report a broken, hours-long duration.
 */
export function mainTitle(titles: DiscTitle[]): DiscTitle | null {
  return titles.reduce<DiscTitle | null>((best, title) => (!best || better(title, best) ? title : best), null);
}

/** PRGV current,total,max — percent of the max counter. */
export function progressPercent(line: string): number | null {
  const match = /^PRGV:(\d+),\d+,(\d+)/.exec(line.trim());
  if (!match) return null;
  const max = Number(match[2]);
  if (!max) return null;
  return Math.max(0, Math.min(100, Math.round((Number(match[1]) / max) * 100)));
}
