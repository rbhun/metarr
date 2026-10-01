export type ServiceApp = "plex" | "radarr" | "sonarr" | "bazarr";

export async function openService(catalogId: number, app: ServiceApp, episodeId?: number): Promise<string> {
  const response = await fetch(`/api/library/${catalogId}/arr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "open", app, episodeId }),
  });
  const body = (await response.json()) as { url?: string; message?: string; error?: string };
  if (!response.ok) throw new Error(body.error || "The request failed.");
  if (body.url) window.open(body.url, "_blank", "noopener,noreferrer");
  return body.message || "Opening.";
}

export async function pushToPlex(items: Array<{ catalogId: number; episodeId?: number }>): Promise<string> {
  const response = await fetch("/api/library/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const body = (await response.json()) as { message?: string; error?: string };
  if (!response.ok) throw new Error(body.error || "The request failed.");
  return body.message || "Plex is scanning the selected folders.";
}

export async function scanInPlex(catalogId: number, episodeId?: number): Promise<string> {
  const response = await fetch(`/api/library/${catalogId}/arr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "scan", app: "plex", episodeId }),
  });
  const body = (await response.json()) as { message?: string; error?: string };
  if (!response.ok) throw new Error(body.error || "The request failed.");
  return body.message || "Plex is scanning this folder.";
}
