export const CONNECTORS = ["plex", "radarr", "sonarr", "bazarr"] as const;

export type ConnectorId = (typeof CONNECTORS)[number];

export const PROVIDERS = ["tmdb", "omdb"] as const;

export type ProviderId = (typeof PROVIDERS)[number];

export type ProviderSettings = {
  id: ProviderId;
  apiKey: string;
  enabled: boolean;
};

export type OnlineStatus = "found" | "missing" | "error";

export type OnlineMeta = {
  status: OnlineStatus;
  sources: ProviderId[];
  overview: string | null;
  posterUrl: string | null;
  originalTitle: string | null;
  runtimeMinutes: number | null;
  rating: number | null;
  genres: string[];
  imdbId: string | null;
  tmdbId: string | null;
  tvdbId: string | null;
  fetchedAt: string;
  message: string | null;
};

export type PlayableLabel = "video" | "disc" | "missing";

export type HdrLabel = "Dolby Vision" | "HDR10+" | "HDR10" | "HLG" | "none";

export type TitleKind = "movie" | "series";

export type RecordKind = TitleKind | "episode";

export type MediaFile = {
  container: string | null;
  path: string | null;
  qualityName: string | null;
  resolution: string | null;
  hdr: HdrLabel;
  is3d: boolean;
  audioLanguages: string[];
  subtitleLanguages: string[];
};

export type SourceDraft = {
  connector: ConnectorId;
  kind: RecordKind;
  externalKey: string;
  title: string;
  seriesTitle: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  imdbId: string | null;
  tmdbId: string | null;
  tvdbId: string | null;
  guid: string | null;
  parentKey: string | null;
  hasFile: boolean;
  wanted: boolean;
  monitored: boolean;
  container: string | null;
  path: string | null;
  qualityName: string | null;
  resolution: string | null;
  hdr: HdrLabel;
  is3d: boolean;
  audioLanguages: string[];
  subtitleLanguages: string[];
  subtitleWanted: string[];
  rating: number | null;
  genres: string[];
  files: MediaFile[];
  airDate: string | null;
};

export type ConnectorSettings = {
  id: ConnectorId;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  lastTestMessage: string | null;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastSyncMessage: string | null;
};

export type ConnectorProgress = {
  id: ConnectorId;
  state: "pending" | "running" | "success" | "error" | "skipped";
  message: string;
  fetched: number;
  total: number | null;
};

export type SyncStatusName = "idle" | "running" | "success" | "partial" | "error";

export type SyncStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  status: SyncStatusName;
  connectors: ConnectorProgress[];
  demo: boolean;
};

export type LibraryEpisode = {
  id: number;
  season: number | null;
  episode: number | null;
  title: string;
  hasFile: boolean;
  wanted: boolean;
  container: string | null;
  path: string | null;
  playableLabel: PlayableLabel;
  qualityName: string | null;
  resolution: string | null;
  hdr: HdrLabel;
  is3d: boolean;
  audioLanguages: string[];
  subtitleLanguages: string[];
  subtitleWanted: string[];
  inPlex: boolean;
  inSonarr: boolean;
  inBazarr: boolean;
  airDate: string | null;
};

export type LibraryTitle = {
  id: number;
  kind: TitleKind;
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: string | null;
  tvdbId: string | null;
  inPlex: boolean;
  inRadarr: boolean;
  inSonarr: boolean;
  inBazarr: boolean;
  hasFile: boolean;
  container: string | null;
  path: string | null;
  playableLabel: PlayableLabel;
  playableNote: string | null;
  qualityName: string | null;
  resolution: string | null;
  hdr: HdrLabel;
  is3d: boolean;
  audioLanguages: string[];
  subtitleLanguages: string[];
  subtitleWanted: string[];
  rating: number | null;
  genres: string[];
  missingReason: string | null;
  episodeCount: number;
  episodeFileCount: number;
  missingEpisodeCount: number;
  online: OnlineMeta | null;
};

export type SyncNote = {
  id: ConnectorId;
  ok: boolean | null;
  message: string;
};

export type LibraryResponse = {
  demo: boolean;
  configured: ConnectorId[];
  lastSyncAt: string | null;
  lastSyncStatus: Exclude<SyncStatusName, "running"> | null;
  syncNotes: SyncNote[];
  stats: {
    total: number;
    missing: number;
    notInPlex: number;
    notPlayable: number;
  };
  page: {
    offset: number;
    limit: number;
    filtered: number;
  };
  titles: LibraryTitle[];
};

export const CONNECTOR_LABEL: Record<ConnectorId, string> = {
  plex: "Plex",
  radarr: "Radarr",
  sonarr: "Sonarr",
  bazarr: "Bazarr",
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  tmdb: "TMDB",
  omdb: "OMDb",
};
