import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { deliverFile } from "@/lib/deliver";
import { idle } from "@/lib/idle";
import { planRemuxFiles, safeBaseName } from "@/lib/remux/place";
import { longestTitle, parseDiscTitles, progressPercent } from "@/lib/remux/robot";

const RIP_TIMEOUT_MS = 6 * 60 * 60 * 1000;

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

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

/** Status lines MakeMKV prints on every ISO run; they never explain a failure. */
const ROUTINE =
  /^(Using library|Operation successfully completed|The program can't find any usable optical drives|Using direct disc access mode|AACS directory not present|Loaded content hash table|Profile parsing error|MakeMKV v\S+ \S+ started|Title #?\d+ .*(was added|skipped)|File .* was added as title)/i;
const BETA_KEY_PAGE = "https://forum.makemkv.com/forum/viewtopic.php?t=1053";
const LICENSE = /(too old|registration key|evaluation period|expired|shareware)/i;

/** MSG:code,flags,count,"message","format",params… — only the first quoted field is the text. */
export function makemkvMessages(output: string): string[] {
  const messages: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = /^MSG:[^,]*,[^,]*,[^,]*,"((?:[^"\\]|\\.)*)"/.exec(raw.trim());
    const text = match?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
    if (text && messages.at(-1) !== text) messages.push(text);
  }
  return messages;
}

function stopped(code: number | null, signal: NodeJS.Signals | null): string {
  if (code != null) return `MakeMKV exited with code ${code}.`;
  if (signal === "SIGKILL") return "MakeMKV was killed (SIGKILL), usually because the machine or container ran out of memory.";
  if (signal === "SIGSEGV" || signal === "SIGABRT" || signal === "SIGBUS" || signal === "SIGILL") {
    return `MakeMKV crashed (${signal}). MakeMKV 2.0.0 crashes on Blu-rays; update Metarr so it installs 1.18.4. If it still crashes, check the key in Settings → Disc remux and open the MakeMKV log in Tasks.`;
  }
  if (signal) return `MakeMKV was stopped by ${signal}.`;
  return "MakeMKV stopped without an exit code.";
}

export function makemkvFailure(output: string, code: number | null, signal: NodeJS.Signals | null = null): string {
  const messages = makemkvMessages(output);
  const useful = messages.filter((line) => !ROUTINE.test(line));
  const exit = stopped(code, signal);
  if (useful.some((line) => LICENSE.test(line))) {
    const said = useful.filter((line) => LICENSE.test(line)).slice(-1)[0];
    const fix = `Paste a valid key in Settings → Disc remux, then redo this task: a purchased registration key, or the beta key from ${BETA_KEY_PAGE} once the new one is posted.`;
    if (useful.some((line) => /temporary key has expired/i.test(line))) {
      return `The MakeMKV beta key has expired. Without a valid key MakeMKV does not start at all, for DVDs too. ${fix}`;
    }
    if (/too old/i.test(said)) return `MakeMKV has no valid key, so it does not start at all, for DVDs too (“${said}”). ${fix}`;
    return `${said} ${fix}`;
  }
  if (useful.length) return `${useful.slice(-3).join(" ")} (${exit})`;
  const last = messages.slice(-1)[0];
  return last ? `${exit} MakeMKV gave no reason; its last message was: ${last}` : exit;
}

const HOME_LOG = "MakeMKV_log.txt";

/** MakeMKV's own debug log and everything it printed, per step, for Tasks → MakeMKV log. */
function saveOutput(
  logDir: string | undefined,
  home: string,
  step: string,
  output: string,
  code: number | null,
  signal: NodeJS.Signals | null,
) {
  if (!logDir) return;
  try {
    const ending = code === 0 ? "exit 0" : code != null ? `exit ${code}` : `stopped by ${signal ?? "unknown signal"}`;
    fs.writeFileSync(path.join(logDir, `${step}-output.txt`), `${output}\n[${ending}]\n`);
    // MakeMKV ignores the --debug path and writes its log into HOME, replacing it on every run.
    const own = path.join(home, HOME_LOG);
    const debug = path.join(logDir, `${step}-debug.txt`);
    if (!fs.existsSync(debug) && fs.existsSync(own)) fs.copyFileSync(own, debug);
  } catch {
    // The log is only for diagnosis.
  }
}

function runMakeMkv(
  binary: string,
  args: string[],
  home: string,
  onLine: (line: string) => void,
  logDir?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!binary.trim()) {
      reject(new Error("makemkvcon is not set. Enter its path in Settings → Disc remux."));
      return;
    }
    const step = args[0] ?? "run";
    const debug = logDir ? [`--debug=${path.join(logDir, `${step}-debug.txt`)}`] : [];
    if (logDir) fs.rmSync(path.join(home, HOME_LOG), { force: true });
    const wrapped = idle(binary, ["--robot", "--minlength=0", ...debug, ...args]);
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
      fail(
        new Error(
          missing
            ? `${binary} is not installed or not on PATH. Install MakeMKV on this machine, or set the full path in Settings → Disc remux.`
            : error.message,
        ),
      );
    });
    child.on("close", (code, signal) => {
      saveOutput(logDir, home, step, output, code, signal);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else if (code === 127) {
        reject(new Error(`${binary} was not found where Metarr runs. Rebuild the Docker image (it includes MakeMKV), or set the full path in Settings → Disc remux.`));
      } else reject(new Error(makemkvFailure(output, code, signal)));
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
  dryRun?: boolean;
  logDir?: string;
  onProgress: (percent: number, message: string) => void;
}): Promise<string> {
  const { binary, source, outputDir, workDir, label, extras, home, onProgress, logDir } = options;
  onProgress(0, "Reading the disc");
  const info = await runMakeMkv(binary, ["info", source], home, () => undefined, logDir);
  const titles = parseDiscTitles(info);
  const main = longestTitle(titles);
  if (!main) throw new Error("MakeMKV did not find a title on this disc.");
  if (options.dryRun) {
    const target = path.join(outputDir, `${safeBaseName(label)}.mkv`);
    const others = extras && titles.length > 1 ? ` and ${titles.length - 1} other titles as -other files` : "";
    return `Dry run: would remux title ${main.index} (${clock(main.seconds)})${others} into ${target}, keeping every audio and subtitle track. Nothing was written.`;
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const which = extras ? "all" : String(main.index);
    let lastWrite = 0;
    await runMakeMkv(binary, ["mkv", source, which, workDir], home, (line) => {
      const percent = progressPercent(line);
      if (percent == null) return;
      const now = Date.now();
      if (percent < 100 && now - lastWrite < 2_000) return;
      lastWrite = now;
      onProgress(percent, `Remuxing ${percent}%`);
    }, logDir);
    onProgress(100, "Saving files");
    const produced = listMkv(workDir);
    const plan = planRemuxFiles(outputDir, label, produced, extras, (file) => fs.existsSync(file));
    deliverFile(plan.main.from, plan.main.to);
    for (const extra of plan.extras) deliverFile(extra.from, extra.to);
    const movie = path.basename(plan.main.to);
    if (!extras || plan.extras.length === 0) return `Saved ${movie}. The disc was left in place.`;
    const count = plan.extras.length === 1 ? "1 extra" : `${plan.extras.length} extras`;
    return `Saved ${movie} and ${count}. The disc was left in place.`;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
