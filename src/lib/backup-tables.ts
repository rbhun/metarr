export type BackupGroup = "settings" | "tasks" | "library" | "other";

export type BackupTable = {
  name: string;
  label: string;
  group: BackupGroup;
};

export const TABLE_INFO: BackupTable[] = [
  { name: "connectors", label: "Server addresses and keys", group: "settings" },
  { name: "providers", label: "TMDb and OMDb keys", group: "settings" },
  { name: "app_meta", label: "Schedules, login, and other settings", group: "settings" },
  { name: "auth_sessions", label: "Signed-in browsers", group: "settings" },
  { name: "detect_jobs", label: "Language checks", group: "tasks" },
  { name: "detect_results", label: "Languages already recognized", group: "tasks" },
  { name: "remux_jobs", label: "Disc remuxes", group: "tasks" },
  { name: "rewrap_jobs", label: "Rewraps", group: "tasks" },
  { name: "merge_jobs", label: "Version merges", group: "tasks" },
  { name: "subtitle_timing", label: "Subtitle timing", group: "tasks" },
  { name: "source_records", label: "Files read from each server", group: "library" },
  { name: "catalog_titles", label: "Library titles", group: "library" },
  { name: "catalog_episodes", label: "Episodes", group: "library" },
  { name: "enrichment", label: "Posters and online notes", group: "library" },
];

/** Settings and task history. The library list is left out until All tables is checked. */
export function defaultBackupNames(tables: BackupTable[]): string[] {
  return tables.filter((table) => table.group !== "library").map((table) => table.name);
}
