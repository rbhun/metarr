import { franc } from "franc";
import { languageName } from "@/lib/media";

const MEDIA_LANGUAGES = [
  "eng",
  "hun",
  "deu",
  "spa",
  "fra",
  "ita",
  "jpn",
  "kor",
  "cmn",
  "por",
  "rus",
  "pol",
  "nld",
  "swe",
  "nob",
  "dan",
  "fin",
  "ces",
  "tur",
  "arb",
  "hin",
  "ukr",
  "heb",
  "ell",
  "ron",
  "hrv",
  "srp",
  "bul",
  "cat",
  "vie",
  "slk",
  "tha",
  "ind",
];

export function detectTextLanguage(text: string): { language: string | null; confidence: number } {
  const sample = text.replace(/\s+/g, " ").trim();
  const letters = sample.replace(/[^\p{L}]/gu, "");
  if (letters.length < 40) return { language: null, confidence: 0 };
  const code = franc(sample, { only: MEDIA_LANGUAGES, minLength: 20 });
  if (!code || code === "und") return { language: null, confidence: 0 };
  const language = languageName(code);
  return language ? { language, confidence: 1 } : { language: null, confidence: 0 };
}
