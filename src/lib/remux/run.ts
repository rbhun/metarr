import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { planRemuxFiles } from "@/lib/remux/place";
import { longestTitle, parseDiscTitles, progressPercent } from "@/lib/remux/robot";

const RIP_TIMEOUT_MS = 6 * 60 * 60 * 1000;

let idlePrefix: string[] | null = null;

function withIdle(binary: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "linux") return { command: binary, args };
  if (idlePrefix === null) idlePrefix = fs.existsSync("/usr/bin/ionice") ? ["-c", "3", "nice", "-n", "19"] : [];
  if (idlePrefix.length === 0) return { command: binary, args };
  return { command: "ionice", args: [...idlePrefix, binary, ...args] };
}

function listMkv(directory: string): Array<{ path: string; bytes: number }> {
  if (!fs.existsSync(directory)) return [];
  const found: Array<{ path: string; bytes: number }> = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listMkv(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mkv")) found.push({ path: full, bytes: fs.statSync(full).size });
  }
  return found;
}

function placeFile(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "EXDEV") throw caught;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function runMakeMkv(binary: string, args: string[], home: string, onLine: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const wrapped = withIdle(binary, ["--robot", "--minlength=0", ...args]);
    const child = spawn(wrapped.command, wrapped.args, {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("MakeMKV ran longer than 6 hours and was stopped."));
    }, RIP_TIMEOUT_MS);
    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      output = `${output}${line}\n`.slice(-200_000);
      onLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-200_000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine(line);
      }
    });
    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      fail(new Error(missing ? `${wrapped.command} is not installed.` : error.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else {
        const quoted = output
          .split(/\r?\n/)
          .map((line) => /^MSG:[^,]*,[^,]*,[^,]*,"(.*)"\s*$/.exec(line.trim())?.[1] ?? "")
          .filter(Boolean)
          .slice(-2)
          .join(" ");
        reject(new Error(quoted || `MakeMKV exited with code ${code}.`));
      }
    });
  });
}

export async function ripDisc(options: {
  binary: string;
  source: string;
  outputDir: string;
  workDir: string;
  label: string;
  extras: boolean;
  home: string;
  onProgress: (percent: number, message: string) => void;
}): Promise<string> {
  const { binary, source, outputDir, workDir, label, extras, home, onProgress } = options;
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  try {
    onProgress(0, "Reading the disc");
    const info = await runMakeMkv(binary, ["info", source], home, () => undefined);
    const titles = parseDiscTitles(info);
    const main = longestTitle(titles);
    if (!main) throw new Error("MakeMKV did not find a title on this disc.");
    const which = extras ? "all" : String(main.index);
    let lastWrite = 0;
    await runMakeMkv(binary, ["mkv", source, which, workDir], home, (line) => {
      const percent = progressPercent(line);
      if (percent == null) return;
      const now = Date.now();
      if (percent < 100 && now - lastWrite < 2_000) return;
      lastWrite = now;
      onProgress(percent, `Remuxing ${percent}%`);
    });
    onProgress(100, "Saving files");
    const produced = listMkv(workDir);
    const plan = planRemuxFiles(outputDir, label, produced, extras, (file) => fs.existsSync(file));
    placeFile(plan.main.from, plan.main.to);
    for (const extra of plan.extras) placeFile(extra.from, extra.to);
    const movie = path.basename(plan.main.to);
    if (!extras || plan.extras.length === 0) return `Saved ${movie}. The disc was left in place.`;
    const count = plan.extras.length === 1 ? "1 extra" : `${plan.extras.length} extras`;
    return `Saved ${movie} and ${count}. The disc was left in place.`;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
