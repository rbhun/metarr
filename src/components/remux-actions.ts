export async function enqueueRemux(titles: number[], episodes: number[], extras: boolean): Promise<string> {
  const response = await fetch("/api/remux", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ titles, episodes, extras }),
  });
  const body = (await response.json().catch(() => null)) as { error?: string; added?: number; skipped?: number; already?: number } | null;
  if (!response.ok) throw new Error(body?.error || "Could not queue the disc remux.");
  const added = body?.added ?? 0;
  const skipped = body?.skipped ?? 0;
  const already = body?.already ?? 0;
  if (added === 0 && already === 0) return "None of the selected files are disc images.";
  if (added === 0) return "Those discs are already in the queue.";
  const discs = added === 1 ? "1 disc" : `${added} discs`;
  const extra = extras ? " Extras are saved beside the movie." : " Only the longest title is saved.";
  const rest = skipped ? ` ${skipped} selected ${skipped === 1 ? "file is" : "files are"} not a disc.` : "";
  return `Queued ${discs}. One disc runs at a time during the overnight window.${extra}${rest}`;
}
