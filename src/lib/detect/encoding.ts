export function decodeSubtitleBytes(sample: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return new TextDecoder("windows-1250").decode(sample);
  }
}
