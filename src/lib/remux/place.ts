import path from "node:path";

export function safeBaseName(label: string): string {
  const cleaned = label
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return cleaned.slice(0, 180) || "Movie";
}

export type ProducedFile = { path: string; bytes: number };

export type PlannedMove = { from: string; to: string };

export function planRemuxFiles(
  directory: string,
  label: string,
  produced: ProducedFile[],
  extras: boolean,
  exists: (file: string) => boolean,
): { main: PlannedMove; extras: PlannedMove[] } {
  if (produced.length === 0) throw new Error("MakeMKV did not write an MKV.");
  const ranked = [...produced].sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
  const base = safeBaseName(label);
  const mainTo = path.join(directory, `${base}.mkv`);
  if (exists(mainTo)) throw new Error(`${base}.mkv already exists next to the disc.`);
  const reserved = new Set<string>([mainTo]);
  const extraMoves: PlannedMove[] = [];
  if (extras) {
    let number = 1;
    for (const file of ranked.slice(1)) {
      let destination = "";
      while (number < 500) {
        const name = number === 1 ? `${base}-other.mkv` : `${base}-other${number}.mkv`;
        destination = path.join(directory, name);
        number += 1;
        if (!exists(destination) && !reserved.has(destination)) break;
      }
      reserved.add(destination);
      extraMoves.push({ from: file.path, to: destination });
    }
  }
  return { main: { from: ranked[0].path, to: mainTo }, extras: extraMoves };
}
