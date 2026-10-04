import path from "node:path";
import { languageFromSubtitleName } from "@/lib/detect/sidecars";
import { fileExtension, languageCode, sidecarLanguageCode } from "@/lib/media";

const MATROSKA = new Set(["mkv", "mka", "mks", "mk3d", "webm"]);
const ISO_BMFF = new Set(["mp4", "m4v", "mov", "m4p"]);
/** AVI stores a language in the file header (IAS1 for the first audio track), not on the track. */
const RIFF = new Set(["avi", "divx"]);
const SIDECAR = new Set(["srt", "ass", "ssa", "vtt", "sub", "idx"]);
const FLAG = /[._-](forced|sdh|cc|hi)$/i;

export type TagPlan =
  | { action: "matroska"; selector: string; language: string; commentary: boolean; forced: boolean }
  | { action: "mp4"; specifier: string; language: string; commentary: boolean; forced: boolean }
  | { action: "riff"; header: string; language: string; commentary: boolean }
  | { action: "rename"; to: string; pairFrom: string | null; pairTo: string | null }
  | { action: "skip"; reason: "unknown-language" | "container" | "already-named" };

/** Insert a Plex-style language code into a sidecar name, keeping a forced/SDH flag at the end. */
export function renamedSidecar(file: string, code: string): string | null {
  if (languageFromSubtitleName(path.basename(file))) return null;
  const ext = path.extname(file);
  if (!ext) return null;
  const stem = file.slice(0, file.length - ext.length);
  const flag = stem.match(FLAG);
  if (flag && flag.index != null && flag.index > 0) {
    return `${stem.slice(0, flag.index)}.${code}${stem.slice(flag.index)}${ext}`;
  }
  return `${stem}.${code}${ext}`;
}

function withForcedFlag(file: string): string {
  const ext = path.extname(file);
  const stem = ext ? file.slice(0, -ext.length) : file;
  if (FLAG.test(stem)) return file;
  return `${stem}.forced${ext}`;
}

function sidecarPair(file: string): string | null {
  if (/\.idx$/i.test(file)) return file.replace(/\.idx$/i, ".sub");
  if (/\.sub$/i.test(file)) return file.replace(/\.sub$/i, ".idx");
  return null;
}

export function planTag(
  file: string,
  kind: "audio" | "subtitle",
  ordinal: number,
  language: string,
  role: "commentary" | "forced" | "short" | null,
): TagPlan {
  const fileCode = languageCode(language);
  const nameCode = sidecarLanguageCode(language);
  if (!fileCode && !nameCode) return { action: "skip", reason: "unknown-language" };
  const ext = fileExtension(file);
  const commentary = kind === "audio" && role === "commentary";
  const forced = kind === "subtitle" && role === "forced";
  if (ext && MATROSKA.has(ext)) {
    if (!fileCode) return { action: "skip", reason: "unknown-language" };
    const track = kind === "audio" ? "a" : "s";
    return { action: "matroska", selector: `track:${track}${ordinal + 1}`, language: fileCode, commentary, forced };
  }
  if (ext && ISO_BMFF.has(ext)) {
    if (!fileCode) return { action: "skip", reason: "unknown-language" };
    const track = kind === "audio" ? "a" : "s";
    return { action: "mp4", specifier: `s:${track}:${ordinal}`, language: fileCode, commentary, forced };
  }
  if (ext && RIFF.has(ext) && kind === "audio" && ordinal < 9) {
    if (!fileCode) return { action: "skip", reason: "unknown-language" };
    return { action: "riff", header: `IAS${ordinal + 1}`, language: fileCode, commentary };
  }
  if (ext && SIDECAR.has(ext) && kind === "subtitle") {
    if (!nameCode) return { action: "skip", reason: "unknown-language" };
    const named = renamedSidecar(file, nameCode);
    if (!named) return { action: "skip", reason: "already-named" };
    const to = forced ? withForcedFlag(named) : named;
    const pairFrom = sidecarPair(file);
    const pairNamed = pairFrom ? renamedSidecar(pairFrom, nameCode) : null;
    const pairTo = pairNamed && forced ? withForcedFlag(pairNamed) : pairNamed;
    return { action: "rename", to, pairFrom: pairTo ? pairFrom : null, pairTo };
  }
  return { action: "skip", reason: "container" };
}

/** A saved recognition still needs writing when this container can store it and the track has no language. */
export function fileOmitsSavedLanguage(plan: TagPlan, existing: string | null): boolean {
  return plan.action !== "skip" && !existing;
}

export function retargetPath(storedPath: string, localFrom: string, localTo: string): string {
  const stored = storedPath.replace(/\\/g, "/");
  const from = localFrom.replace(/\\/g, "/");
  const to = localTo.replace(/\\/g, "/");
  if (stored === from) return to;
  const fromName = from.split("/").pop() ?? "";
  const toName = to.split("/").pop() ?? "";
  if (!fromName || !toName) return to;
  const at = stored.lastIndexOf(fromName);
  if (at === stored.length - fromName.length && (at === 0 || stored[at - 1] === "/")) {
    return `${stored.slice(0, at)}${toName}`;
  }
  return to;
}
