import { spawn } from "node:child_process";
import readline from "node:readline";
import { idle } from "@/lib/idle";
import { watchStall } from "@/lib/stuck";

/** What to say when ffmpeg or ffprobe does not exit 0. A signal kill has no exit code. */
export function rewrapStop(command: string, code: number | null, signal: NodeJS.Signals | null): string {
  if (code != null) return `${command} exited with code ${code}.`;
  if (signal === "SIGKILL") return `${command} was killed (SIGKILL), usually because the machine ran out of memory.`;
  if (signal) return `${command} was stopped by ${signal}.`;
  return `${command} stopped without an exit code.`;
}

export function runTool(
  command: string,
  args: string[],
  timeoutMs: number,
  onLine: (line: string) => void = () => undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const wrapped = idle(command, args);
    const child = spawn(wrapped.command, wrapped.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unwatch();
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${command} ran longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`));
    }, timeoutMs);
    const unwatch = watchStall(child.pid, command, (error) => {
      child.kill("SIGKILL");
      fail(error);
    });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      stdout = `${stdout}${line}\n`.slice(-500_000);
      onLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-20_000);
    });
    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      fail(new Error(missing ? `${command} is not installed where Metarr runs. Rebuild the Docker image, which includes ffmpeg.` : error.message));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unwatch();
      if (code === 0) {
        resolve(stdout);
        return;
      }
      if (code === 127) {
        reject(new Error(`${command} was not found where Metarr runs. Rebuild the Docker image, which includes ffmpeg.`));
        return;
      }
      const said = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" ");
      const exit = rewrapStop(command, code, signal);
      if (said && code != null) {
        reject(new Error(said));
        return;
      }
      reject(new Error(said ? `${said} (${exit})` : exit));
    });
  });
}

