import { normalizeImdb, normalizeNumericId, normalizeTitle } from "@/lib/media";
import type { TitleKind } from "@/lib/types";

export type Matchable = {
  kind: TitleKind;
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: string | null;
  tvdbId: string | null;
  guid: string | null;
  extraKeys?: string[];
};

export function fallbackKey(kind: TitleKind, title: string, year: number | null): string | null {
  if (!year || !title.trim()) return null;
  const normalized = normalizeTitle(title);
  if (!normalized) return null;
  return `${kind}|${normalized}|${year}`;
}

export function externalKeys(item: Matchable): string[] {
  const keys: string[] = [];
  const imdb = normalizeImdb(item.imdbId);
  if (imdb) keys.push(`imdb:${item.kind}:${imdb}`);
  const tmdb = normalizeNumericId(item.tmdbId);
  if (tmdb) keys.push(`tmdb:${item.kind}:${tmdb}`);
  const tvdb = normalizeNumericId(item.tvdbId);
  if (tvdb) keys.push(`tvdb:${item.kind}:${tvdb}`);
  if (item.guid?.trim()) keys.push(`guid:${item.kind}:${item.guid.trim()}`);
  for (const extra of item.extraKeys ?? []) {
    if (extra.trim()) keys.push(extra.trim());
  }
  return keys;
}

/**
 * Group records that share an external id. Title + year is only used when it is unambiguous:
 * id-less rows join a single id-backed group, or each other when nobody has an id.
 * Two groups that already disagree on ids stay apart.
 */
export function clusterMatches<T extends Matchable>(items: T[]): T[][] {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[leftRoot] = rightRoot;
  };

  const buckets = new Map<string, number>();
  items.forEach((item, index) => {
    for (const key of externalKeys(item)) {
      const previous = buckets.get(key);
      if (previous === undefined) buckets.set(key, index);
      else union(previous, index);
    }
  });

  const byFallback = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = fallbackKey(item.kind, item.title, item.year);
    if (!key) return;
    const list = byFallback.get(key) ?? [];
    list.push(index);
    byFallback.set(key, list);
  });

  for (const indexes of byFallback.values()) {
    const roots = new Map<number, number[]>();
    for (const index of indexes) {
      const root = find(index);
      const members = roots.get(root) ?? [];
      members.push(index);
      roots.set(root, members);
    }
    if (roots.size <= 1) continue;
    const rooted = [...roots.entries()].map(([root, members]) => ({
      root,
      hasExternal: members.some((index) => externalKeys(items[index]!).length > 0),
    }));
    const withIds = rooted.filter((entry) => entry.hasExternal);
    const withoutIds = rooted.filter((entry) => !entry.hasExternal);
    if (withIds.length === 1) {
      for (const loose of withoutIds) union(withIds[0]!.root, loose.root);
    } else if (withIds.length === 0 && withoutIds.length > 1) {
      const first = withoutIds[0]!;
      for (const other of withoutIds.slice(1)) union(first.root, other.root);
    }
  }

  const groups = new Map<number, T[]>();
  items.forEach((item, index) => {
    const root = find(index);
    const list = groups.get(root) ?? [];
    list.push(item);
    groups.set(root, list);
  });
  return [...groups.values()];
}
