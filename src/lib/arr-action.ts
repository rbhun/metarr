import { asRecord, fetchJson, normalizeBaseUrl } from "@/lib/connectors/http";
import { getDb, listConnectors } from "@/lib/db";

type ArrApp = "radarr" | "sonarr";

export async function plexOpenUrl(catalogId: number, episodeId?: number | null): Promise<{ url: string; message: string }> {
  const db = getDb();
  const title = db.prepare(`SELECT id, kind, title, imdb_id, tmdb_id, tvdb_id, in_plex FROM catalog_titles WHERE id = ?`).get(catalogId) as
    | { id: number; kind: string; title: string; imdb_id: string | null; tmdb_id: string | null; tvdb_id: string | null; in_plex: number }
    | undefined;
  if (!title || !title.in_plex) throw new Error("This title is not in Plex.");
  const connector = listConnectors(db).find((item) => item.id === "plex");
  if (!connector?.enabled || !connector.baseUrl || !connector.apiKey) {
    throw new Error("Plex is not connected. Add it in Settings.");
  }
  const ratingKey = episodeId ? episodeRatingKey(db, title.title, episodeId) : itemRatingKey(db, title);
  if (!ratingKey) throw new Error("Metarr could not find this title’s Plex id. Sync again, then retry.");
  const base = normalizeBaseUrl(connector.baseUrl, 32400);
  const payload = await fetchJson(`${base}/identity`, {
    Accept: "application/json",
    "X-Plex-Token": connector.apiKey,
    "X-Plex-Product": "Metarr",
    "X-Plex-Client-Identifier": "metarr-local",
  });
  const identity = asRecord(asRecord(payload)?.MediaContainer) ?? asRecord(payload);
  const machine = typeof identity?.machineIdentifier === "string" ? identity.machineIdentifier : "";
  if (!machine) throw new Error("Plex did not return a server id.");
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return {
    url: `${base}/web/index.html#!/server/${encodeURIComponent(machine)}/details?key=${key}`,
    message: "Opening Plex.",
  };
}

function itemRatingKey(
  db: ReturnType<typeof getDb>,
  title: { kind: string; imdb_id: string | null; tmdb_id: string | null; tvdb_id: string | null },
): string | null {
  const row = db
    .prepare(
      `SELECT external_key FROM source_records
       WHERE connector = 'plex' AND kind = ?
         AND (
           (? <> '' AND imdb_id = ?)
           OR (? <> '' AND tmdb_id = ?)
           OR (? <> '' AND tvdb_id = ?)
         )
       LIMIT 1`,
    )
    .get(
      title.kind === "series" ? "series" : "movie",
      title.imdb_id ?? "",
      title.imdb_id ?? "",
      title.tmdb_id ?? "",
      title.tmdb_id ?? "",
      title.tvdb_id ?? "",
      title.tvdb_id ?? "",
    ) as { external_key: string } | undefined;
  return row?.external_key.match(/^item:(\d+)$/)?.[1] ?? null;
}

function episodeRatingKey(db: ReturnType<typeof getDb>, seriesTitle: string, episodeId: number): string | null {
  const episode = db.prepare(`SELECT season, episode FROM catalog_episodes WHERE id = ?`).get(episodeId) as
    | { season: number | null; episode: number | null }
    | undefined;
  if (!episode) return null;
  const row = db
    .prepare(
      `SELECT external_key FROM source_records
       WHERE connector = 'plex' AND kind = 'episode' AND series_title = ? AND season IS ? AND episode IS ?
       LIMIT 1`,
    )
    .get(seriesTitle, episode.season, episode.episode) as { external_key: string } | undefined;
  return row?.external_key.match(/^episode:(\d+)$/)?.[1] ?? null;
}

export async function bazarrOpenUrl(catalogId: number): Promise<{ url: string; message: string }> {
  const db = getDb();
  const title = db.prepare(`SELECT kind, title, imdb_id, tmdb_id, tvdb_id, in_bazarr FROM catalog_titles WHERE id = ?`).get(catalogId) as
    | { kind: string; title: string; imdb_id: string | null; tmdb_id: string | null; tvdb_id: string | null; in_bazarr: number }
    | undefined;
  if (!title || !title.in_bazarr) throw new Error("This title is not in Bazarr.");
  const connector = listConnectors(db).find((item) => item.id === "bazarr");
  if (!connector?.enabled || !connector.baseUrl || !connector.apiKey) {
    throw new Error("Bazarr is not connected. Add it in Settings.");
  }
  const base = normalizeBaseUrl(connector.baseUrl, 6767);
  if (title.kind === "movie") {
    const row = db
      .prepare(
        `SELECT external_key FROM source_records
         WHERE connector = 'bazarr' AND kind = 'movie'
           AND (
             (? <> '' AND imdb_id = ?)
             OR (? <> '' AND tmdb_id = ?)
           )
         LIMIT 1`,
      )
      .get(title.imdb_id ?? "", title.imdb_id ?? "", title.tmdb_id ?? "", title.tmdb_id ?? "") as { external_key: string } | undefined;
    const radarrId = row?.external_key.match(/^radarr:(\d+)$/)?.[1];
    return {
      url: radarrId ? `${base}/movies/${radarrId}` : `${base}/movies`,
      message: "Opening Bazarr.",
    };
  }
  const row = db
    .prepare(
      `SELECT parent_key FROM source_records
       WHERE connector = 'bazarr' AND parent_key LIKE 'sonarr-series:%' AND series_title = ?
       LIMIT 1`,
    )
    .get(title.title) as { parent_key: string } | undefined;
  const seriesId = row?.parent_key.match(/^sonarr-series:(\d+)$/)?.[1];
  return {
    url: seriesId ? `${base}/series/${seriesId}` : `${base}/series`,
    message: "Opening Bazarr.",
  };
}

export async function arrAction(catalogId: number, action: "open" | "search", appOverride?: ArrApp): Promise<{ url?: string; message: string }> {
  const db = getDb();
  const title = db
    .prepare(`SELECT kind, title, imdb_id, tmdb_id, tvdb_id, in_radarr, in_sonarr FROM catalog_titles WHERE id = ?`)
    .get(catalogId) as
    | { kind: string; title: string; imdb_id: string | null; tmdb_id: string | null; tvdb_id: string | null; in_radarr: number; in_sonarr: number }
    | undefined;
  if (!title) throw new Error("Unknown title.");
  const inferred: ArrApp | null = title.kind === "movie" && title.in_radarr ? "radarr" : title.kind === "series" && title.in_sonarr ? "sonarr" : null;
  const app = appOverride ?? inferred;
  if (appOverride === "radarr" && !title.in_radarr) throw new Error("This movie is not in Radarr.");
  if (appOverride === "sonarr" && !title.in_sonarr) throw new Error("This series is not in Sonarr.");
  if (!app) throw new Error(title.kind === "movie" ? "This movie is not in Radarr." : "This series is not in Sonarr.");

  const connector = listConnectors(db).find((item) => item.id === app);
  if (!connector?.enabled || !connector.baseUrl || !connector.apiKey) {
    throw new Error(`${app === "radarr" ? "Radarr" : "Sonarr"} is not connected. Add it in Settings.`);
  }
  const id = serviceId(db, app, title);
  if (!id) throw new Error(`Metarr could not find this title’s id in ${app === "radarr" ? "Radarr" : "Sonarr"}. Sync again, then retry.`);

  const base = normalizeBaseUrl(connector.baseUrl, app === "radarr" ? 7878 : 8989);
  const headers = { Accept: "application/json", "X-Api-Key": connector.apiKey };
  const item = asRecord(await fetchJson(`${base}/api/v3/${app === "radarr" ? "movie" : "series"}/${id}`, headers));
  const slug = typeof item?.titleSlug === "string" ? item.titleSlug : "";
  const label = app === "radarr" ? "Radarr" : "Sonarr";
  if (action === "open") {
    if (!slug) throw new Error(`${label} did not return a page for this title.`);
    return { url: `${base}/${app === "radarr" ? "movie" : "series"}/${encodeURIComponent(slug)}`, message: `Opening ${label}.` };
  }

  const response = await fetch(`${base}/api/v3/command`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(app === "radarr" ? { name: "MoviesSearch", movieIds: [Number(id)] } : { name: "SeriesSearch", seriesId: Number(id) }),
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`${label} rejected the search (HTTP ${response.status}).`);
  return { message: `${label} is searching for ${title.title}.` };
}

function serviceId(
  db: ReturnType<typeof getDb>,
  app: ArrApp,
  title: { imdb_id: string | null; tmdb_id: string | null; tvdb_id: string | null },
): string | null {
  const row = db
    .prepare(
      `SELECT external_key FROM source_records
       WHERE connector = ? AND kind = ?
         AND (
           (? <> '' AND imdb_id = ?)
           OR (? <> '' AND tmdb_id = ?)
           OR (? <> '' AND tvdb_id = ?)
         )
       LIMIT 1`,
    )
    .get(
      app,
      app === "radarr" ? "movie" : "series",
      title.imdb_id ?? "",
      title.imdb_id ?? "",
      title.tmdb_id ?? "",
      title.tmdb_id ?? "",
      title.tvdb_id ?? "",
      title.tvdb_id ?? "",
    ) as { external_key: string } | undefined;
  return row && /^\d+$/.test(row.external_key) ? row.external_key : null;
}
