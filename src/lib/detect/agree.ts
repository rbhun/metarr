const MIN_PROBABILITY = 0.8;

export function agreeLanguage(samples: Array<{ language: string; probability: number }>): { language: string | null; confidence: number } {
  const usable = samples.filter((sample) => sample.language && sample.probability > 0);
  if (usable.length === 0) return { language: null, confidence: 0 };
  const counts = new Map<string, { count: number; probability: number }>();
  for (const sample of usable) {
    const key = sample.language.toLowerCase();
    const row = counts.get(key) ?? { count: 0, probability: 0 };
    row.count += 1;
    row.probability = Math.max(row.probability, sample.probability);
    counts.set(key, row);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1].count - left[1].count || right[1].probability - left[1].probability);
  const top = ranked[0];
  if (!top) return { language: null, confidence: 0 };
  const [language, stats] = top;
  const majority = stats.count >= Math.ceil(usable.length / 2);
  if (!majority || stats.probability < MIN_PROBABILITY) return { language: null, confidence: stats.probability };
  return { language, confidence: stats.probability };
}
