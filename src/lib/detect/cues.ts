export function cueText(raw: string): string {
  const pieces: string[] = [];
  for (const line of raw.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(WEBVTT|NOTE\b|Style:|Format:|Script Info|\[)/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed) || trimmed.includes("-->")) continue;
    let text = trimmed;
    if (/^Dialogue:/i.test(trimmed)) text = trimmed.split(",").slice(9).join(",");
    text = text
      .replace(/\{[^}]*\}/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\\N/gi, " ")
      .trim();
    if (!text) continue;
    pieces.push(text);
    if (pieces.length >= 80) break;
  }
  return pieces.join(" ");
}
