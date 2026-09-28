type RewrapResponse = { error?: string; added?: number; already?: number; promoted?: number; skipped?: number };

async function postRewrap(body: Record<string, unknown>): Promise<RewrapResponse> {
  const response = await fetch("/api/rewrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as RewrapResponse | null;
  if (!response.ok) throw new Error(payload?.error || "Could not queue the AVI rewrap.");
  return payload ?? {};
}

function describe(payload: RewrapResponse, immediate: boolean): string {
  const added = payload.added ?? 0;
  const already = payload.already ?? 0;
  const promoted = payload.promoted ?? 0;
  const skipped = payload.skipped ?? 0;
  const rest = skipped ? ` ${skipped} ${skipped === 1 ? "path is" : "paths are"} not an AVI.` : "";
  if (added === 0 && already === 0 && promoted === 0) return `Nothing to rewrap: no AVI without an MKV was found.${rest}`;
  if (immediate) {
    if (added === 0 && promoted === 0) return "That AVI is already rewrapping or waiting to start now.";
    return `Rewrapping now. Follow it in Tasks. One AVI runs at a time.${rest}`;
  }
  if (added === 0) return `Those AVIs are already in the queue.${rest}`;
  const files = added === 1 ? "1 AVI" : `${added} AVIs`;
  return `Queued ${files} for Tasks. They run one at a time during the AVI rewrap hours.${rest}`;
}

export async function enqueueRewrapPaths(paths: Array<{ path: string; label?: string }>, immediate = false): Promise<string> {
  return describe(await postRewrap({ paths, immediate }), immediate);
}

/** Starts now instead of waiting for the AVI rewrap hours. */
export async function rewrapNow(titles: number[], episodes: number[]): Promise<string> {
  return describe(await postRewrap({ titles, episodes, immediate: true }), true);
}
