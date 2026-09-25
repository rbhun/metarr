const COMMENTARY = [
  /\bcommentary\b/i,
  /\bin this scene\b/i,
  /\bwe (shot|filmed|decided|wanted|wrote|thought)\b/i,
  /\bthe director\b/i,
  /\bon set\b/i,
  /\bbehind the scenes\b/i,
  /\bi remember when\b/i,
  /\bwhen we (were|shot|filmed)\b/i,
  /\bour (film|movie)\b/i,
];

export function commentaryRole(label: string | null | undefined, transcript: string): "commentary" | null {
  if (label && /\bcommentary\b|\bcomm\b/i.test(label)) return "commentary";
  const hits = COMMENTARY.filter((pattern) => pattern.test(transcript)).length;
  return hits >= 2 ? "commentary" : null;
}
