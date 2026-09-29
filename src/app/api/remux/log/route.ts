import { readMakemkvLog } from "@/lib/remux/logs";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  if (!Number.isInteger(id) || id <= 0) return new Response("Give a remux job id.", { status: 400, headers });
  const text = readMakemkvLog(getDb().name, id);
  if (!text) {
    return new Response(
      `No MakeMKV log for job ${id}. MakeMKV did not run for it: the task stopped before MakeMKV started, and the task's own message says why. (Jobs that ran before version 0.0.105 have no log either.)`,
      { status: 404, headers },
    );
  }
  return new Response(text, { headers });
}
