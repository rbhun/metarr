import { pullBazarr } from "@/lib/connectors/bazarr";
import { pullPlex } from "@/lib/connectors/plex";
import { pullRadarr } from "@/lib/connectors/radarr";
import { pullSonarr } from "@/lib/connectors/sonarr";
import type { ProgressUpdate } from "@/lib/connectors/http";
import { rebuildCatalog } from "@/lib/catalog";
import {
  connectorHasRecords,
  deleteAllSourceRecords,
  deleteConnectorRecords,
  getDb,
  getMeta,
  insertSourceRecords,
  isDemo,
  listConnectors,
  plexExcludedLibraries,
  recordConnectorSync,
  setMeta,
} from "@/lib/db";
import { CONNECTORS, CONNECTOR_LABEL, type ConnectorId, type ConnectorProgress, type SourceDraft, type SyncNote, type SyncStatus } from "@/lib/types";

type Memory = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  status: SyncStatus["status"];
  connectors: ConnectorProgress[];
};

const globalForSync = globalThis as unknown as { __metarrSync?: Memory };

function freshConnectors(): ConnectorProgress[] {
  return CONNECTORS.map((id) => ({
    id,
    state: "pending",
    message: "Waiting",
    fetched: 0,
    total: null,
  }));
}

function memory(): Memory {
  if (!globalForSync.__metarrSync) {
    globalForSync.__metarrSync = {
      running: false,
      startedAt: null,
      finishedAt: null,
      status: "idle",
      connectors: freshConnectors(),
    };
  }
  return globalForSync.__metarrSync;
}

function persistedNotes(): SyncNote[] {
  const raw = getMeta(getDb(), "last_sync_notes");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SyncNote[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getSyncStatus(): SyncStatus {
  const current = memory();
  const demo = isDemo();
  if (current.running) {
    return { ...current, connectors: current.connectors.map((item) => ({ ...item })), demo };
  }
  const status = getMeta(getDb(), "last_sync_status");
  const finishedAt = getMeta(getDb(), "last_sync_at");
  const connectors = rememberedConnectors();
  return {
    running: false,
    startedAt: null,
    finishedAt,
    status: status === "success" || status === "partial" || status === "error" || status === "idle" ? status : "idle",
    connectors,
    demo,
  };
}

function describe(records: SourceDraft[]): string {
  const movies = records.filter((record) => record.kind === "movie").length;
  const series = records.filter((record) => record.kind === "series").length;
  const episodes = records.filter((record) => record.kind === "episode").length;
  const parts: string[] = [];
  if (movies) parts.push(`${movies} movie${movies === 1 ? "" : "s"}`);
  if (series) parts.push(`${series} series`);
  if (episodes) parts.push(`${episodes} episode${episodes === 1 ? "" : "s"}`);
  return parts.length ? `Saved ${parts.join(", ")}.` : "The server returned no titles.";
}

async function pullConnector(
  id: ConnectorId,
  baseUrl: string,
  apiKey: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<SourceDraft[]> {
  if (id === "plex") return pullPlex(baseUrl, apiKey, onProgress, plexExcludedLibraries());
  if (id === "radarr") return pullRadarr(baseUrl, apiKey, onProgress);
  if (id === "sonarr") return pullSonarr(baseUrl, apiKey, onProgress);
  return pullBazarr(baseUrl, apiKey, onProgress);
}

async function runSync(only?: ConnectorId) {
  const status = memory();
  const db = getDb();
  const wasDemo = isDemo(db);
  const staged = new Map<ConnectorId, SourceDraft[]>();

  for (const connector of listConnectors(db)) {
    if (only && connector.id !== only) continue;
    const slot = status.connectors.find((item) => item.id === connector.id);
    if (!slot) continue;
    const hasCredentials = Boolean(connector.baseUrl.trim() && connector.apiKey.trim());
    const configured = only ? hasCredentials : connector.enabled && hasCredentials;
    if (!configured) {
      slot.state = "skipped";
      slot.message = only
        ? "Save a base URL and key before syncing."
        : connector.enabled
          ? "Add a base URL and key before syncing."
          : "Disconnected";
      continue;
    }
    slot.state = "running";
    slot.message = `Connecting to ${CONNECTOR_LABEL[connector.id]}`;
    try {
      const records = await pullConnector(connector.id, connector.baseUrl, connector.apiKey, (update) => {
        slot.message = update.message;
        slot.fetched = update.fetched;
        slot.total = update.total;
      });
      staged.set(connector.id, records);
      slot.state = "success";
      slot.message = describe(records);
      slot.fetched = records.length;
      slot.total = records.length;
    } catch (error) {
      slot.state = "error";
      slot.message = error instanceof Error ? error.message : "Sync failed.";
    }
  }

  const demoCleared = wasDemo && staged.size > 0;
  for (const slot of status.connectors) {
    if (slot.state !== "error") continue;
    if (only && slot.id !== only) continue;
    if (demoCleared) {
      slot.message = `${slot.message} Sample rows for this app were cleared because another app synced.`;
    } else if (!wasDemo && connectorHasRecords(db, slot.id)) {
      slot.message = `${slot.message} Previous data for this app was kept.`;
    } else if (wasDemo) {
      slot.message = `${slot.message} Demo library was left in place.`;
    }
  }

  if (staged.size > 0) {
    const write = db.transaction(() => {
      if (wasDemo) {
        deleteAllSourceRecords(db);
        setMeta(db, "demo", "0");
      }
      for (const [id, records] of staged) {
        if (!wasDemo) deleteConnectorRecords(db, id);
        insertSourceRecords(db, records);
        const slot = status.connectors.find((item) => item.id === id);
        recordConnectorSync(id, true, slot?.message ?? "Synced.", db);
      }
      for (const slot of status.connectors) {
        if (only && slot.id !== only) continue;
        if (slot.state === "error") recordConnectorSync(slot.id, false, slot.message, db);
      }
      rebuildCatalog(db);
    });
    write();
  } else {
    for (const slot of status.connectors) {
      if (only && slot.id !== only) continue;
      if (slot.state === "error") recordConnectorSync(slot.id, false, slot.message, db);
    }
  }

  const finishedAt = new Date().toISOString();
  const previous = persistedNotes();
  const notes: SyncNote[] = status.connectors.map((slot) => {
    if (only && slot.id !== only) {
      return previous.find((note) => note.id === slot.id) ?? { id: slot.id, ok: null, message: slot.message };
    }
    return {
      id: slot.id,
      ok: slot.state === "success" ? true : slot.state === "error" ? false : null,
      message: slot.message,
    };
  });
  const noteFailures = notes.filter((note) => note.ok === false).length;
  const noteSuccesses = notes.filter((note) => note.ok === true).length;
  const outcome = noteSuccesses > 0 && noteFailures > 0 ? "partial" : noteSuccesses > 0 ? "success" : noteFailures > 0 ? "error" : "idle";
  setMeta(db, "last_sync_at", finishedAt);
  setMeta(db, "last_sync_status", outcome);
  setMeta(db, "last_sync_notes", JSON.stringify(notes));

  status.running = false;
  status.finishedAt = finishedAt;
  status.status = outcome;
}

function rememberedConnectors(): ConnectorProgress[] {
  const notes = persistedNotes();
  return freshConnectors().map((item) => {
    const note = notes.find((entry) => entry.id === item.id);
    if (!note) return { ...item, state: "skipped" as const, message: "Not synced yet" };
    return {
      ...item,
      state: note.ok == null ? ("skipped" as const) : note.ok ? ("success" as const) : ("error" as const),
      message: note.message,
    };
  });
}

export function startSync(only?: ConnectorId): { started: boolean; status: SyncStatus } {
  const status = memory();
  if (status.running) return { started: false, status: getSyncStatus() };
  status.running = true;
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.status = "running";
  status.connectors = (only ? rememberedConnectors() : freshConnectors()).map((item) =>
    !only || item.id === only ? { id: item.id, state: "pending", message: "Waiting", fetched: 0, total: null } : item,
  );
  void runSync(only).catch((error: unknown) => {
    const current = memory();
    current.running = false;
    current.finishedAt = new Date().toISOString();
    current.status = "error";
    const message = error instanceof Error ? error.message : "Sync failed.";
    for (const slot of current.connectors) {
      if (slot.state === "running" || slot.state === "pending") {
        slot.state = "error";
        slot.message = message;
      }
    }
  });
  return { started: true, status: getSyncStatus() };
}
