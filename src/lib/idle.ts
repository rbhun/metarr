import fs from "node:fs";

let prefix: string[] | null = null;

/** Run a tool at idle IO and lowest CPU priority, so Plex playback always wins. */
export function idle(command: string, args: string[]): { command: string; args: string[] } {
  if (prefix === null) prefix = fs.existsSync("/usr/bin/ionice") ? ["ionice", "-c", "3", "nice", "-n", "19"] : ["nice", "-n", "19"];
  const [head, ...rest] = prefix;
  return { command: head, args: [...rest, command, ...args] };
}
