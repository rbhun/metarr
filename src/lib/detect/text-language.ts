import { asTuples } from "trigram-utils";
import { data } from "franc/data.js";
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

const MAX_DIFFERENCE = 300;
const MIN_GAP = 0.02;

const models = new Map<string, Record<string, number>>();
for (const languages of Object.values(data)) {
  for (const code of MEDIA_LANGUAGES) {
    const raw = languages[code];
    if (!raw || models.has(code)) continue;
    const parts = raw.split("|");
    const model: Record<string, number> = {};
    let weight = parts.length;
    while (weight--) {
      const token = parts[weight];
      if (token) model[token] = weight;
    }
    models.set(code, model);
  }
}

export function detectTextLanguage(text: string): { language: string | null; confidence: number } {
  const sample = text.replace(/\s+/g, " ").trim().slice(0, 2048);
  const letters = sample.replace(/[^\p{L}]/gu, "");
  if (letters.length < 40) return { language: null, confidence: 0 };
  const tuples = asTuples(sample) as Array<[string, number]>;
  if (tuples.length === 0) return { language: null, confidence: 0 };
  let bestCode = "";
  let bestScore = 0;
  let secondScore = 0;
  for (const [code, model] of models) {
    let distance = 0;
    for (const [trigram, count] of tuples) {
      const weight = model[trigram];
      const difference = weight == null ? MAX_DIFFERENCE : Math.abs(count - weight - 1);
      distance += difference;
    }
    const score = 1 - distance / (tuples.length * MAX_DIFFERENCE);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestCode = code;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (!bestCode || bestScore - secondScore < MIN_GAP) return { language: null, confidence: bestScore };
  const language = languageName(bestCode);
  return language ? { language, confidence: bestScore } : { language: null, confidence: bestScore };
}
