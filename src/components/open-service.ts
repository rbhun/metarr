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

/** Open the folders of these titles for Plex, check them again, and say what changed. */
export async function fixFolderMasks(items: Array<{ catalogId: number; episodeId?: number }>): Promise<{ message: string; failed: string | null }> {
  const response = await fetch("/api/folder-mask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    opened?: string[];
    failed?: Array<{ path: string; error: string }>;
    remaining?: string[];
  } | null;
  if (!response.ok) throw new Error(body?.error || "Could not check the folders.");
  const opened = body?.opened?.length ?? 0;
  const remaining = body?.remaining?.length ?? 0;
  const first = body?.failed?.[0];
  const message = opened
    ? `Opened ${opened === 1 ? "1 path" : `${opened} paths`} for Plex.${remaining ? ` ${remaining === 1 ? "1 is" : `${remaining} are`} still closed.` : ""}`
    : remaining
      ? `${remaining === 1 ? "1 folder is" : `${remaining} folders are`} still closed.`
      : "Plex can read these folders.";
  return { message, failed: first ? `${first.path}: ${first.error}` : null };
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
