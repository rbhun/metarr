import type { ConnectorId, HdrLabel, LibraryTitle, PlayableLabel } from "@/lib/types";
import { CONNECTOR_LABEL } from "@/lib/types";

export function formatWhen(value: string | null | undefined): string {
  if (!value) return "Never synced";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never synced";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatRuntime(minutes: number | null | undefined): string {
  if (!minutes) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

export function formatRating(value: number | null): string {
  if (value == null) return "—";
  return value.toFixed(1);
}

export function formatList(values: string[]): string {
  return values.length ? values.join(", ") : "—";
}

export function playableText(label: PlayableLabel): string {
  if (label === "disc") return "Disc image";
  if (label === "video") return "Video file";
  return "Missing file";
}

export function hdrText(label: HdrLabel): string {
  return label === "none" ? "None" : label;
}

export function episodeCode(season: number | null, episode: number | null): string {
  if (season == null || episode == null) return "Special";
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export function arrPresence(title: LibraryTitle, configured: ConnectorId[]) {
  const candidates: ConnectorId[] = title.kind === "movie" ? ["radarr", "bazarr"] : ["sonarr", "bazarr"];
  const apps = candidates
    .filter((id) => configured.includes(id))
    .map((id) => ({
      id,
      label: CONNECTOR_LABEL[id],
      present: id === "radarr" ? title.inRadarr : id === "sonarr" ? title.inSonarr : title.inBazarr,
    }));
  const missing = apps.filter((app) => !app.present).map((app) => app.label);
  const summary =
    apps.length === 0
      ? "No *arr apps connected"
      : missing.length === 0
        ? "In all connected *arr apps"
        : `Missing from ${missing.join(" and ")}`;
  return { apps, summary };
}
