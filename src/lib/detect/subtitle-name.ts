import { languageName, languageOptions } from "@/lib/media";

const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt|sub|idx)$/i;
const SKIP_TOKEN = /^(forced|sdh|cc|foreign|normal|default|hi)$/i;
const KNOWN = new Set(languageOptions().map((name) => name.toLowerCase()));

export function isSubtitleFile(file: string): boolean {
  return SUBTITLE_EXT.test(file);
}

/** MicroDVD `.sub` files are text. A VobSub `.sub` is an MPEG packet stream. */
export function subtitleSampleIsText(sample: Uint8Array): boolean {
  if (sample.length === 0) return false;
  let noisy = 0;
  for (const byte of sample) {
    if (byte === 0 || byte < 9 || (byte > 13 && byte < 32)) noisy += 1;
  }
  return noisy / sample.length <= 0.02;
}

export function fileBaseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

export function languageFromSubtitleName(fileName: string): string | null {
  const stem = fileName.replace(SUBTITLE_EXT, "");
  const parts = stem.split(/[._\-\s]+/).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const token = parts[index];
    if (!token || SKIP_TOKEN.test(token)) continue;
    const named = languageName(token);
    if (!named) continue;
    const tokenKey = token.toLowerCase();
    const namedKey = named.toLowerCase();
    if (KNOWN.has(tokenKey)) return languageOptions().find((option) => option.toLowerCase() === tokenKey) ?? named;
    if (KNOWN.has(namedKey) && namedKey !== tokenKey) return named;
  }
  return null;
}
