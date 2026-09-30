import { languageName, languageOptions } from "@/lib/media";

const AUDIO_EXT = /\.(ac3|eac3|dts|dtshd|dtsma|truehd|thd|flac|mka|aac|m4a|wav|mp3|ogg|opus)$/i;
const SKIP_TOKEN = /^(forced|sdh|cc|foreign|normal|default|hi|commentary|comm)$/i;
const KNOWN = new Set(languageOptions().map((name) => name.toLowerCase()));

export function isAudioFile(file: string): boolean {
  return AUDIO_EXT.test(file);
}

export function fileBaseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

export function languageFromAudioName(fileName: string): string | null {
  const stem = fileName.replace(AUDIO_EXT, "");
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

/** Codec the library shows, from a separate audio file's extension. */
export function audioCodecFromName(fileName: string): string | null {
  const ext = fileName.match(AUDIO_EXT)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (ext === "ac3") return "Dolby Digital";
  if (ext === "eac3") return "Dolby Digital Plus";
  if (ext === "dts") return "DTS";
  if (ext === "dtshd" || ext === "dtsma") return "DTS-HD";
  if (ext === "truehd" || ext === "thd") return "Dolby TrueHD";
  if (ext === "flac") return "FLAC";
  if (ext === "aac" || ext === "m4a") return "AAC";
  if (ext === "mp3") return "MP3";
  if (ext === "wav") return "PCM";
  if (ext === "ogg" || ext === "opus") return "Opus";
  return null;
}
