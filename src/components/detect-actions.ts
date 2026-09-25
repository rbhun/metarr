type DetectRequest = {
  path: string;
  kind: "audio" | "subtitle";
  ordinal: number;
  label: string;
  format: string | null;
  placement: string | null;
  streamLabel: string | null;
};

function detectionMessage(mode: "now" | "queue", added: number, already: number): string {
  if (added === 0 && already > 0) return already === 1 ? "That track is already in Tasks." : `${already} tracks are already in Tasks.`;
  if (added === 0) return "Those files have no unknown audio or subtitle tracks to scan.";
  const tracks = added === 1 ? "1 track" : `${added} tracks`;
  return mode === "now" ? `Started ${tracks}. Follow it in Tasks.` : `Queued ${tracks} for the scheduled window.`;
}

async function postDetection(body: Record<string, unknown>, mode: "now" | "queue"): Promise<string> {
  const response = await fetch("/api/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, ...body }),
  });
  const payload = (await response.json().catch(() => null)) as { error?: string; added?: number; already?: number } | null;
  if (!response.ok) throw new Error(payload?.error || "Could not queue language detection.");
  return detectionMessage(mode, payload?.added ?? 0, payload?.already ?? 0);
}

export async function enqueueDetection(mode: "now" | "queue", titles: number[], episodes: number[]): Promise<string> {
  return postDetection({ titles, episodes }, mode);
}

export async function enqueueTrack(track: DetectRequest): Promise<string> {
  return enqueueTracks([track]);
}

export async function enqueueTracks(tracks: DetectRequest[]): Promise<string> {
  return postDetection({ tracks }, "now");
}
