export async function enqueueDetection(mode: "now" | "queue", titles: number[], episodes: number[]): Promise<string> {
  const response = await fetch("/api/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, titles, episodes }),
  });
  const body = (await response.json().catch(() => null)) as { error?: string; added?: number } | null;
  if (!response.ok) throw new Error(body?.error || "Could not queue language detection.");
  const added = body?.added ?? 0;
  if (added === 0) return "Those files have no unknown audio or subtitle tracks to scan.";
  const tracks = added === 1 ? "1 track" : `${added} tracks`;
  return mode === "now" ? `Started ${tracks}. Audio listens one file at a time.` : `Queued ${tracks} for the scheduled window.`;
}
