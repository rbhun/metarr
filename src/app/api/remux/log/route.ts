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
      `No MakeMKV log for job ${id}. Logs are saved from version 0.0.105 on; redo the task to get one.`,
      { status: 404, headers },
    );
  }
  return new Response(text, { headers });
}
