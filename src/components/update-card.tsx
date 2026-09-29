"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VERSION } from "@/lib/version";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type DeployRun = {
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  before: string;
  after: string | null;
};

type DeployState = {
  version: string;
  available: boolean;
  requestedAt: string | null;
  stuck: boolean;
  run: DeployRun | null;
  log: string;
  error?: string;
};

function when(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusText(state: DeployState | null, offline: boolean): string {
  if (offline) return "Metarr is restarting with the new version…";
  if (!state) return "Checking…";
  if (!state.available) return "Off: the update helper is not installed on the host yet. Run deploy.sh once from the console to install it.";
  if (state.requestedAt && state.stuck) {
    return "The request has not been picked up. Check that metarr-deploy.path is running on the host (systemctl status metarr-deploy.path).";
  }
  if (state.requestedAt) return "Update requested. Waiting for the host to start it…";
  const run = state.run;
  if (!run) return `Version ${state.version}. No update has been run from here yet.`;
  if (run.state === "running") return `Updating since ${when(run.startedAt)}…`;
  if (run.state === "failed") return `The last update failed ${when(run.finishedAt)} (exit code ${run.exitCode ?? "unknown"}). The log is below.`;
  const changed = run.after && run.after !== run.before ? `${run.before} → ${run.after}` : "already up to date";
  return `Version ${state.version}. Last update ${when(run.finishedAt)}: ${changed}.`;
}

export function UpdateCard() {
  const [state, setState] = useState<DeployState | null>(null);
  const [offline, setOffline] = useState(false);
  const [sending, setSending] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const busy = useRef(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/deploy", { cache: "no-store" });
      if (!response.ok) throw new Error("offline");
      const next = (await response.json()) as DeployState;
      setState(next);
      setOffline(false);
      busy.current = Boolean(next.requestedAt) || next.run?.state === "running";
    } catch {
      if (busy.current) setOffline(true);
    }
  }, []);

  useEffect(() => {
    let timer = 0;
    const tick = async () => {
      await load();
      timer = window.setTimeout(() => void tick(), busy.current ? 3_000 : 30_000);
    };
    timer = window.setTimeout(() => void tick(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function update() {
    if (!window.confirm("Pull the latest Metarr and rebuild it now? Metarr restarts for about a minute; running tasks pick up again afterwards.")) return;
    setSending(true);
    try {
      const response = await fetch("/api/deploy", { method: "POST" });
      const body = (await response.json().catch(() => null)) as (DeployState & { result?: string }) | null;
      if (!response.ok || !body) throw new Error(body?.error || "The update could not be requested.");
      setState(body);
      busy.current = true;
      setShowLog(true);
      toast.success(body.result === "already" ? "An update is already on its way." : "Update requested. Metarr restarts when the new version is built.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The update could not be requested.");
    } finally {
      setSending(false);
    }
  }

  const working = offline || Boolean(state?.requestedAt && !state.stuck) || state?.run?.state === "running";
  const newer = state && state.version !== VERSION;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Update Metarr</CardTitle>
        <CardDescription>
          Pulls the latest main branch and rebuilds the container with deploy.sh, the same as running it from the console. The host runs it; Metarr only
          asks. Media files are never touched.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm leading-6">{statusText(state, offline)}</p>
        {newer ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
            <span>
              Metarr is now {state.version}; this page is still {VERSION}.
            </span>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!state?.available || working || sending} onClick={() => void update()}>
            {working ? "Updating…" : sending ? "Requesting…" : "Update now"}
          </Button>
          {state?.log ? (
            <Button size="sm" variant="outline" onClick={() => setShowLog((value) => !value)}>
              {showLog ? "Hide log" : "Show log"}
            </Button>
          ) : null}
        </div>
        {showLog && state?.log ? (
          <pre className="max-h-72 overflow-auto rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-5 whitespace-pre-wrap">{state.log}</pre>
        ) : null}
      </CardContent>
    </Card>
  );
}
