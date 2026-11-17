import type Database from "better-sqlite3";

export type OrderQueue = "language" | "remux" | "rewrap" | "merge";

const TABLE: Record<OrderQueue, string> = {
  language: "detect_jobs",
  remux: "remux_jobs",
  rewrap: "rewrap_jobs",
  merge: "merge_jobs",
};

type Row = { queue: OrderQueue; id: number; rank: number };

function pending(db: Database.Database, scope: OrderQueue | "all"): Row[] {
  const queues = scope === "all" ? (Object.keys(TABLE) as OrderQueue[]) : [scope];
  const rows: Row[] = [];
  for (const queue of queues) {
    const found = db.prepare(`SELECT id, rank FROM ${TABLE[queue]} WHERE status = 'pending'`).all() as Array<{ id: number; rank: number }>;
    for (const row of found) rows.push({ queue, id: row.id, rank: row.rank });
  }
  rows.sort((a, b) => a.rank - b.rank || a.queue.localeCompare(b.queue) || a.id - b.id);
  return rows;
}

function writeRank(db: Database.Database, row: Row, rank: number) {
  db.prepare(`UPDATE ${TABLE[row.queue]} SET rank = ? WHERE id = ?`).run(rank, row.id);
}

/** The waiting job at the front of the list. It is the one that skips the schedule. */
export function leadTask(db: Database.Database): Row | null {
  return pending(db, "all")[0] ?? null;
}

/**
 * The front job is the only one that skips the schedule. Every other waiting job
 * keeps its place and waits for the window.
 */
export function promoteLead(db: Database.Database): void {
  const lead = leadTask(db);
  db.prepare(`UPDATE detect_jobs SET priority = 'window' WHERE status = 'pending' AND priority = 'immediate'`).run();
  db.prepare(`UPDATE remux_jobs SET immediate = 0 WHERE status = 'pending' AND immediate = 1`).run();
  db.prepare(`UPDATE rewrap_jobs SET immediate = 0 WHERE status = 'pending' AND immediate = 1`).run();
  if (!lead) return;
  if (lead.queue === "language") db.prepare(`UPDATE detect_jobs SET priority = 'immediate' WHERE id = ? AND status = 'pending'`).run(lead.id);
  if (lead.queue === "remux") db.prepare(`UPDATE remux_jobs SET immediate = 1 WHERE id = ? AND status = 'pending'`).run(lead.id);
  if (lead.queue === "rewrap") db.prepare(`UPDATE rewrap_jobs SET immediate = 1 WHERE id = ? AND status = 'pending'`).run(lead.id);
}

/** Put these waiting jobs at the front, keeping their order. The first id becomes the front. */
export function placeGroupAtFront(db: Database.Database, queue: OrderQueue, ids: number[]) {
  if (!ids.length) return;
  const wanted = new Set(ids);
  const rows = pending(db, "all");
  const others = rows.filter((row) => row.queue !== queue || !wanted.has(row.id));
  const min = others.reduce((low, row) => Math.min(low, row.rank), 0);
  ids.forEach((id, index) => writeRank(db, { queue, id, rank: min }, min - ids.length + index));
}

/** Put this waiting job ahead of every other one, so it becomes the front of the list. */
export function placeAtFront(db: Database.Database, queue: OrderQueue, id: number) {
  placeGroupAtFront(db, queue, [id]);
}

export function rankLookup(db: Database.Database): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of pending(db, "all")) map.set(`${row.queue}:${row.id}`, row.rank);
  return map;
}

/** Move a waiting job one step, or to the front. Scope is the list the user is looking at. */
export function moveTask(
  db: Database.Database,
  scope: OrderQueue | "all",
  queue: OrderQueue,
  id: number,
  direction: "up" | "down" | "top",
): "moved" | "missing" | "edge" | "already" {
  const rows = pending(db, scope);
  const index = rows.findIndex((row) => row.queue === queue && row.id === id);
  if (index < 0) return "missing";
  if (direction === "top") {
    const lead = leadTask(db);
    if (lead?.queue === queue && lead.id === id) return "already";
    placeAtFront(db, queue, id);
    return "moved";
  }
  const next = direction === "up" ? index - 1 : index + 1;
  if (next < 0 || next >= rows.length) return "edge";
  const swapped = rows[index];
  const neighbor = rows[next];
  if (!swapped || !neighbor) return "edge";
  const all = pending(db, "all");
  const from = all.findIndex((row) => row.queue === swapped.queue && row.id === swapped.id);
  const to = all.findIndex((row) => row.queue === neighbor.queue && row.id === neighbor.id);
  if (from < 0 || to < 0) return "missing";
  const ordered = all.slice();
  const moving = ordered[from];
  const other = ordered[to];
  if (!moving || !other) return "missing";
  ordered[from] = other;
  ordered[to] = moving;
  db.transaction(() => {
    ordered.forEach((row, place) => writeRank(db, row, place));
  })();
  return "moved";
}
