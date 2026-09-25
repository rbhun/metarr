import { playableName } from "@/lib/media";
import { CONNECTOR_LABEL, type AudioTrack, type ConnectorId, type HdrLabel, type LibraryTitle, type PlayableLabel, type SubtitleTrack } from "@/lib/types";

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

export function formatBitrate(kbps: number | null | undefined): string {
  if (kbps == null || kbps <= 0) return "—";
  if (kbps >= 1000) {
    const mbps = kbps / 1000;
    return `${Number.isInteger(mbps) ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
  }
  return `${Math.round(kbps)} kbps`;
}

export function differingLength(
  versions: Array<{ durationMinutes?: number | null; fileBytes?: number | null }>,
): "runtime" | "size" | null {
  const minutes = versions.map((version) => version.durationMinutes ?? null);
  if (minutes.length > 1 && minutes.every((value) => value != null) && new Set(minutes).size > 1) return "runtime";
  const sizes = versions.map((version) => version.fileBytes ?? null);
  if (sizes.filter((value) => value != null && value > 0).length > 1 && new Set(sizes).size > 1) return "size";
  return null;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function formatList(values: string[]): string {
  return values.length ? values.join(", ") : "—";
}

export function formatLayout(layout: string | null | undefined): string | null {
  if (!layout) return null;
  const found = layout.match(/\d\.\d(?:\.\d)?/);
  if (found) return found[0];
  if (/stereo/i.test(layout)) return "2.0";
  if (/mono/i.test(layout)) return "1.0";
  return layout;
}

export function shownLanguage(track: { language: string | null; detectedLanguage?: string | null }): string | null {
  return track.language || track.detectedLanguage || null;
}

export function audioLines(tracks: AudioTrack[], languages: string[]): string[] {
  if (tracks.length > 0) {
    const lines = tracks
      .map((track) =>
        [shownLanguage(track) ?? "Unknown", track.detectedRole === "commentary" ? "commentary" : null, formatLayout(track.layout), track.codec]
          .filter(Boolean)
          .join(" "),
      )
      .filter(Boolean);
    return lines.length ? lines : ["—"];
  }
  return languages.length ? languages : ["—"];
}

export function formatAudio(tracks: AudioTrack[], languages: string[]): string {
  const lines = audioLines(tracks, languages);
  return lines.length === 1 && lines[0] === "—" ? "—" : lines.join(", ");
}

export function subtitleLines(tracks: SubtitleTrack[], languages: string[]): string[] {
  if (tracks.length > 0) {
    const lines = tracks.map((track) => {
      const place = track.placement === "burn-in" ? "burn-in" : track.placement;
      return [shownLanguage(track) ?? "Unknown", place, track.format, track.forced ? "forced" : null].filter(Boolean).join(" · ");
    });
    return lines.length ? lines : ["—"];
  }
  return languages.length ? languages : ["—"];
}

export function formatSubtitles(tracks: SubtitleTrack[], languages: string[]): string {
  const lines = subtitleLines(tracks, languages);
  return lines.length === 1 && lines[0] === "—" ? "—" : lines.join(", ");
}

export function playableText(label: PlayableLabel): string {
  return playableName(label);
}

export function hdrText(label: HdrLabel): string {
  return label === "none" ? "SDR" : label;
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
