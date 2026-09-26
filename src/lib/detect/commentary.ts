const STRONG = [
  /\bcommentary\b/i,
  /\bwe (shot|filmed|decided|wanted|wrote|thought)\b/i,
  /\bthe director\b/i,
  /\bon (the )?set\b/i,
  /\bbehind the scenes\b/i,
  /\bi remember\b/i,
  /\bwhen we (were|shot|filmed)\b/i,
  /\bour (film|movie)\b/i,
  /\bthe (cast|crew|camera)\b/i,
  /\bthis shot\b/i,
];

export function commentaryRole(label: string | null | undefined, transcript: string): "commentary" | null {
  if (label && /\bcommentary\b|\bcomm\b/i.test(label)) return "commentary";
  const strong = STRONG.filter((pattern) => pattern.test(transcript)).length;
  return strong >= 1 ? "commentary" : null;
}
