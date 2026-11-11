import { MIN_LANGUAGE_PROBABILITY } from "@/lib/detect/agree";
import type { StoredDetection } from "@/lib/detect/store";
import { languageName } from "@/lib/media";
import { canRewrap } from "@/lib/rewrap/source";

export type ProbeSample = {
  offsetSeconds: number | null;
  language: string;
  probability: number;
  text: string;
};

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function named(language: string): string {
  return languageName(language) ?? language;
}

function percent(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

/** The note stored with a language check: where it listened, how sure it was, and what it kept. */
export function formatProbeLog(input: {
  samples: ProbeSample[];
  language: string | null;
  confidence: number;
  message: string | null;
  fromFile?: boolean;
}): string {
  if (input.fromFile && input.language) {
    return `The file already names this track as ${input.language}, so it was not probed.`;
  }
  const lines: string[] = [];
  if (input.samples.length === 0) {
    lines.push(input.message ?? "This track was not probed.");
  } else {
    lines.push(input.samples.length === 1 ? "Probed one sample." : `Probed ${input.samples.length} samples.`);
    for (const sample of input.samples) {
      const where = sample.offsetSeconds == null ? "A slice of the file" : clock(sample.offsetSeconds);
      const heard = sample.language ? named(sample.language) : "no language";
      const quote = sample.text.trim() ? ` “${sample.text.trim().slice(0, 140)}”` : "";
      lines.push(`${where}: ${heard}, ${percent(sample.probability)}.${quote}`);
    }
  }
  if (input.language) {
    lines.push(`Kept ${input.language} at ${percent(input.confidence)}.`);
    return lines.join("\n");
  }
  if (input.samples.length === 0) return lines.join("\n");
  lines.push(input.message ?? "The language was not kept.");
  const heard = input.samples.filter((sample) => sample.language);
  const first = heard[0];
  if (first && heard.every((sample) => sample.language.toLowerCase() === first.language.toLowerCase())) {
    const best = Math.max(...heard.map((sample) => sample.probability));
    lines.push(
      `Every sample said ${named(first.language)}, and the highest probability was ${percent(best)}. A language is kept from ${percent(MIN_LANGUAGE_PROBABILITY)} upward.`,
    );
  }
  return lines.join("\n");
}

/** A check from before sample notes were stored, or a check whose note is already saved. */
export function describeStoredDetection(found: StoredDetection, filePath: string | null): string | null {
  if (found.log) return found.log;
  if (!found.language && !found.message) return null;
  const lines: string[] = [];
  if (found.language) {
    const certainty =
      found.source === "file"
        ? " It was read from the file."
        : found.confidence != null && found.confidence > 0 && found.confidence < 1
          ? ` The best sample was ${percent(found.confidence)}.`
          : "";
    lines.push(`Recognized ${found.language}.${certainty} The sample-by-sample note was not stored for this check.`);
  } else if (found.message) {
    const certainty = found.confidence != null && found.confidence > 0 ? ` The best sample was ${percent(found.confidence)}.` : "";
    lines.push(`${found.message}${certainty}`);
  }
  if (found.language && filePath && canRewrap(null, filePath)) {
    lines.push("Plex does not read a language stored in this file. An MKV copy carries the language on the audio stream, which is what Plex reads.");
  } else if (found.language && !found.writtenAt) {
    lines.push("This language was not written into a file Plex reads.");
  }
  return lines.join("\n");
}
