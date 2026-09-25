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
