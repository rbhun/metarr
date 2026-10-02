import { deployStatus, requestDeploy } from "@/lib/deploy";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await deployStatus());
}

export async function POST() {
  let result;
  try {
    result = requestDeploy();
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "unknown error";
    return NextResponse.json({ error: `Metarr could not leave the update request in its run folder (${detail}).` }, { status: 500 });
  }
  if (result === "unavailable") {
    return NextResponse.json(
      { error: "The update helper is not installed on the host yet. Run deploy.sh once from the console; it installs the helper." },
      { status: 409 },
    );
  }
  return NextResponse.json({ result, ...(await deployStatus()) });
}
