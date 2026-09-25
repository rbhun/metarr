import type { ConnectorId } from "@/lib/types";

export type ProgressUpdate = {
  message: string;
  fetched: number;
  total: number | null;
};

export const DEFAULT_PORT: Record<ConnectorId, number> = {
  plex: 32400,
  radarr: 7878,
  sonarr: 8989,
  bazarr: 6767,
};

export function normalizeBaseUrl(input: string, defaultPort?: number): string {
  let trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a base URL.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) trimmed = `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Enter an IP address or a full URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  const authority = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  if (defaultPort && !/:\d+$/.test(authority)) url.port = String(defaultPort);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v3$/i, "").replace(/\/api$/i, "");
  return `${url.origin}${path}`;
}

export function rejectUrlAsKey(apiKey: string, baseUrl: string): string | null {
  const key = apiKey.trim();
  if (!key) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(key) || key === baseUrl.trim()) {
    return "The API key field contains the server address. Paste the key from the app’s Settings → General → API Key, then Save.";
  }
  return null;
}

export async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 25000): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error("Timed out waiting for the server.");
    }
    throw new Error("Could not reach the server. Check the base URL and that this machine can open it.");
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`The server rejected the key (HTTP ${response.status}).`);
    }
    throw new Error(`The server returned HTTP ${response.status}.`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("The server did not return JSON. Check the base URL.");
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function pagePayload(payload: unknown): { items: unknown[]; total: number | null } {
  if (Array.isArray(payload)) return { items: payload, total: payload.length };
  const record = asRecord(payload);
  if (!record) return { items: [], total: 0 };
  const items = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.records)
      ? record.records
      : [];
  const total =
    typeof record.total === "number"
      ? record.total
      : typeof record.totalRecords === "number"
        ? record.totalRecords
        : null;
  return { items, total };
}

export async function mapPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}
