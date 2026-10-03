import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { deliverFile } from "@/lib/deliver";
import { idle } from "@/lib/idle";
import { planRemuxFiles, safeBaseName } from "@/lib/remux/place";
import { formatBytes } from "@/lib/format";
import { mainTitle, parseDiscTitles, progressPercent, type DiscTitle } from "@/lib/remux/robot";

const RIP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PROGRESS = /^PRG[VCT]:/;
/** A remux keeps every byte of the chosen streams; far less than MakeMKV announced means the wrong or a broken title. */
const MIN_SIZE_SHARE = 0.25;

function titleName(title: DiscTitle): string {
  return `title ${title.index}${title.sourceFile ? ` (${title.sourceFile})` : ""}`;
}

function childNamed(directory: string, name: string): string | null {
  try {
    const entry = fs.readdirSync(directory).find((item) => item.toLowerCase() === name);
    return entry ? path.join(directory, entry) : null;
  } catch {
    return null;
  }
}

export type StreamFile = { name: string; bytes: number };

/** The .m2ts files under BDMV/STREAM of a Blu-ray folder source, largest first, or why there are none. */
export function streamFiles(source: string): { files: StreamFile[]; problem: string | null } {
  if (!source.startsWith("file:")) return { files: [], problem: "not a Blu-ray folder (an ISO or a DVD)" };
  const root = source.slice(5);
  const bdmv = childNamed(root, "bdmv");
  if (!bdmv) return { files: [], problem: `no BDMV folder in ${root}` };
  const stream = childNamed(bdmv, "stream");
  if (!stream) return { files: [], problem: `no STREAM folder in ${bdmv}` };
  let names: string[];
  try {
    names = fs.readdirSync(stream);
  } catch (caught) {
    return { files: [], problem: `cannot list ${stream}: ${caught instanceof Error ? caught.message : "unknown error"}` };
  }
  const files: StreamFile[] = [];
  let unreadable = 0;
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".m2ts")) continue;
    try {
      files.push({ name, bytes: fs.statSync(path.join(stream, name)).size });
    } catch {
      unreadable += 1;
    }
  }
  files.sort((a, b) => b.bytes - a.bytes);
  const problem = files.length ? (unreadable ? `${unreadable} .m2ts files could not be read` : null) : `no readable .m2ts files in ${stream}`;
  return { files, problem };
}

export function largestStreamFile(source: string): StreamFile | null {
  return streamFiles(source).files[0] ?? null;
}

/** Plain-text overview for Tasks → MakeMKV log: what is on the disc next to what MakeMKV offered. */
export function discSummary(source: string, titles: DiscTitle[], chosen: DiscTitle | null, stream: { files: StreamFile[]; problem: string | null }): string {
  const lines = [`Source: ${source}`, `MakeMKV titles: ${titles.length}`];
  if (chosen) lines.push(`Chosen: ${titleName(chosen)}, ${clock(chosen.seconds)}, ${formatBytes(chosen.bytes)}`);
  lines.push("", "Largest MakeMKV titles:");
  for (const title of [...titles].sort((a, b) => b.bytes - a.bytes || b.seconds - a.seconds).slice(0, 15)) {
    lines.push(`  ${titleName(title)}  ${clock(title.seconds)}  ${formatBytes(title.bytes)}  clips ${title.segments ?? "?"}`);
  }
  lines.push("", "Largest stream files on the disc:");
  for (const file of stream.files.slice(0, 10)) lines.push(`  ${file.name}  ${formatBytes(file.bytes)}`);
  if (stream.problem) lines.push(`  (${stream.problem})`);
  return `${lines.join("\n")}\n`;
}

/** Null when MakeMKV's chosen title could hold the disc's largest stream file. */
export function missingFeatureMessage(title: DiscTitle, largest: { name: string; bytes: number } | null): string | null {
  if (!largest || largest.bytes < 1024 ** 3 || !title.bytes || largest.bytes <= title.bytes * 2) return null;
  return (
    `MakeMKV did not offer the main film: its largest title is ${titleName(title)}, ${formatBytes(title.bytes)}, ` +
    `but ${largest.name} on the disc is ${formatBytes(largest.bytes)}. Nothing was ripped. ` +
    `Open the MakeMKV log in Tasks (info-output) to see what MakeMKV said about ${largest.name}.`
  );
}

/** Null when the saved MKV is plausibly the whole title. */
export function undersizedMessage(title: DiscTitle, savedBytes: number): string | null {
  if (!title.bytes || savedBytes >= title.bytes * MIN_SIZE_SHARE) return null;
  return (
    `MakeMKV saved only ${formatBytes(savedBytes)} of the ${formatBytes(title.bytes)} ${titleName(title)}, ` +
    `so nothing was saved next to the disc. Open the MakeMKV log in Tasks for its reason.`
  );
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

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

/** Status lines MakeMKV prints on every ISO run; they never explain a failure. */
const ROUTINE =
  /^(Using library|Operation successfully completed|The program can't find any usable optical drives|Using direct disc access mode|AACS directory not present|Loaded content hash table|Profile parsing error|MakeMKV v\S+ \S+ started|Title #?\d+ .*(was added|skipped)|File .* was added as title)/i;
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
    return `${said} Blu-ray needs a MakeMKV key (DVDs do not): paste the current beta key or your registration key in Settings → Disc remux, then redo this task.`;
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
    // Every line except progress counters: a disc with a hundred titles prints megabytes of TINFO/SINFO,
    // and the title list must stay whole for parsing.
    const kept: string[] = [];
    let keptBytes = 0;
    const keep = (text: string) => {
      if (keptBytes > MAX_OUTPUT_BYTES) return;
      kept.push(text);
      keptBytes += text.length;
    };
    const collected = () => kept.join("");
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
      if (!PROGRESS.test(line)) keep(`${line}\n`);
      onLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      keep(text);
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
      const output = collected();
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
  const main = mainTitle(titles);
  if (!main) throw new Error("MakeMKV did not find a title on this disc.");
  const stream = streamFiles(source);
  if (logDir) {
    try {
      fs.writeFileSync(path.join(logDir, "disc.txt"), discSummary(source, titles, main, stream));
    } catch {
      // The summary is only for diagnosis.
    }
  }
  const missing = missingFeatureMessage(main, stream.files[0] ?? null);
  if (missing) throw new Error(missing);
  if (options.dryRun) {
    const target = path.join(outputDir, `${safeBaseName(label)}.mkv`);
    const others = extras && titles.length > 1 ? ` and ${titles.length - 1} other titles as -other files` : "";
    return `Dry run: would remux ${titleName(main)}, ${clock(main.seconds)}, ${formatBytes(main.bytes)}${others} into ${target}, keeping every audio and subtitle track. Nothing was written.`;
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
    const saved = produced.find((file) => file.path === plan.main.from)?.bytes ?? 0;
    const short = undersizedMessage(main, saved);
    if (short) throw new Error(short);
    deliverFile(plan.main.from, plan.main.to);
    for (const extra of plan.extras) deliverFile(extra.from, extra.to);
    const movie = path.basename(plan.main.to);
    const from = `from ${titleName(main)}, ${clock(main.seconds)}, ${formatBytes(saved)}`;
    if (!extras || plan.extras.length === 0) return `Saved ${movie} ${from}. The disc was left in place.`;
    const count = plan.extras.length === 1 ? "1 extra" : `${plan.extras.length} extras`;
    return `Saved ${movie} ${from}, and ${count}. The disc was left in place.`;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
