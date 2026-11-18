"use client";

import { CpuReadout } from "@/components/cpu-readout";
import { TaskCount } from "@/components/detect-tasks";
import { RemuxCount } from "@/components/remux-tasks";
import { StuckToolsWarning } from "@/components/stuck-tools-warning";
import { VERSION } from "@/lib/version";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { CONNECTOR_LABEL, type ConnectorId, type SyncStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Disc3, FolderLock, GitMerge, Library, ListTodo, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { toast } from "sonner";

type ShellContextValue = {
  status: SyncStatus | null;
  epoch: number;
  startSync: (id?: ConnectorId) => Promise<void>;
  cancelSync: () => Promise<void>;
  bump: () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell() {
  const value = useContext(ShellContext);
  if (!value) throw new Error("Shell context is missing.");
  return value;
}

const NAV = [
  { href: "/", label: "Library", icon: Library },
  { href: "/rips", label: "Rips", icon: Disc3 },
  { href: "/merge", label: "Merge", icon: GitMerge, beta: true },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/settings", label: "Settings", icon: Settings },
];

function navItemClass(collapsed: boolean) {
  return cn(
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
    collapsed && "justify-center px-2",
  );
}

function NavLinks({
  onNavigate,
  collapsed = false,
  bump,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
  bump: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((entry) => {
        const Icon = entry.icon;
        const current = entry.href === "/" ? pathname === "/" : pathname === entry.href || pathname.startsWith(`${entry.href}/`);
        return (
          <Link
            key={entry.href}
            href={entry.href}
            onClick={onNavigate}
            title={collapsed ? entry.label : undefined}
            aria-label={entry.label}
            aria-current={current ? "page" : undefined}
            className={cn(navItemClass(collapsed), current && "bg-sidebar-accent text-foreground")}
          >
            <Icon />
            {collapsed ? <span className="sr-only">{entry.label}</span> : entry.label}
            {!collapsed && "beta" in entry && entry.beta ? <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">Beta</span> : null}
            {entry.href === "/tasks" ? <TaskCount bump={bump} className={collapsed ? "sr-only" : "ml-auto text-xs"} /> : null}
            {entry.href === "/rips" ? <RemuxCount className={collapsed ? "sr-only" : "ml-auto text-xs"} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [syncOpen, setSyncOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [maskOpen, setMaskOpen] = useState(false);
  const [maskBusy, setMaskBusy] = useState(false);
  const [closedPaths, setClosedPaths] = useState<string[] | null>(null);
  const [maskFailures, setMaskFailures] = useState<Array<{ path: string; error: string }>>([]);
  const [maskResult, setMaskResult] = useState<string | null>(null);
  const pathname = usePathname();
  const bare = pathname === "/login" || pathname === "/setup";

  useEffect(() => {
    setCollapsed(window.localStorage.getItem("metarr-sidebar") === "collapsed");
  }, []);

  function toggleCollapsed() {
    setCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem("metarr-sidebar", next ? "collapsed" : "open");
      return next;
    });
  }
  const bump = useCallback(() => setEpoch((value) => value + 1), []);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/sync", { cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/login");
      return;
    }
    if (!response.ok) return;
    const next = (await response.json()) as SyncStatus;
    setStatus((previous) => {
      if (previous?.running && !next.running) bump();
      else if (previous && !next.running && previous.finishedAt !== next.finishedAt) bump();
      return next;
    });
  }, [bump]);

  useEffect(() => {
    if (bare) return;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bare, refresh]);

  useEffect(() => {
    if (bare) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, status?.running || syncOpen ? 800 : 10_000);
    return () => window.clearInterval(timer);
  }, [bare, refresh, status?.running, syncOpen]);

  const startSync = useCallback(async (id?: ConnectorId) => {
    setSyncOpen(true);
    if (status?.running) return;
    await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(id ? { id } : {}),
    });
    await refresh();
  }, [refresh, status?.running]);

  const cancelSync = useCallback(async () => {
    if (!status?.running) return;
    const response = await fetch("/api/sync", { method: "DELETE" });
    if (!response.ok) {
      toast.error("Could not cancel the sync.");
      return;
    }
    toast.success("Stopping sync…");
    await refresh();
  }, [refresh, status?.running]);

  function openFolders() {
    setMaskResult(null);
    setMaskFailures([]);
    setMaskOpen(true);
    void fetch("/api/folder-scan", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { unreadable?: string[] };
        setClosedPaths(body.unreadable ?? []);
      })
      .catch(() => setClosedPaths([]));
  }

  async function fixFolders() {
    setMaskBusy(true);
    setMaskResult(null);
    try {
      const response = await fetch("/api/folder-mask", { method: "POST" });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        opened?: string[];
        failed?: Array<{ path: string; error: string }>;
        remaining?: string[];
      } | null;
      if (!response.ok) throw new Error(body?.error || "Could not check the folders.");
      const opened = body?.opened?.length ?? 0;
      const remaining = body?.remaining ?? [];
      const failed = body?.failed ?? [];
      setClosedPaths(remaining);
      setMaskFailures(failed);
      setMaskResult(
        opened
          ? `Opened ${opened === 1 ? "1 path" : `${opened} paths`}. ${remaining.length === 0 ? "The check is clear." : `${remaining.length} still closed.`}`
          : remaining.length
            ? `${remaining.length === 1 ? "1 path is" : `${remaining.length} paths are`} still closed.`
            : "Every folder is open to Plex.",
      );
      bump();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not check the folders.";
      setMaskResult(message);
      toast.error(message);
    } finally {
      setMaskBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  if (bare) {
    return (
      <ShellContext.Provider value={{ status, epoch, startSync, cancelSync, bump }}>
        <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">{children}</div>
      </ShellContext.Provider>
    );
  }

  return (
    <ShellContext.Provider value={{ status, epoch, startSync, cancelSync, bump }}>
      <div className="flex h-dvh bg-background text-foreground">
        <aside
          className={cn(
            "hidden h-full min-h-0 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar md:flex",
            collapsed ? "w-14" : "w-60",
          )}
        >
          <div className={cn("flex items-start gap-2 py-4", collapsed ? "justify-center px-2" : "px-4")}>
            {collapsed ? (
              <div className="flex flex-col items-center gap-2">
                <CpuReadout compact />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Expand sidebar"
                  aria-expanded={false}
                  onClick={toggleCollapsed}
                >
                  <PanelLeftOpen />
                </Button>
              </div>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold tracking-tight">Metarr</p>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{VERSION}</p>
                    <CpuReadout />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">Metadata for Plex, Radarr, Sonarr, and Bazarr.</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Collapse sidebar"
                  aria-expanded={true}
                  onClick={toggleCollapsed}
                >
                  <PanelLeftClose />
                </Button>
              </>
            )}
          </div>
          <div className={cn("flex flex-col gap-1", collapsed ? "px-2" : "px-3")}>
            <NavLinks collapsed={collapsed} bump={bump} />
            <button type="button" className={navItemClass(collapsed)} title={collapsed ? "Fix folders" : undefined} onClick={openFolders}>
              <FolderLock />
              {collapsed ? <span className="sr-only">Fix folders</span> : "Fix folders"}
            </button>
          </div>
          <div className={cn("mt-auto flex flex-col gap-1 pb-3", collapsed ? "px-2" : "px-3")}>
            <button type="button" className={navItemClass(collapsed)} title={collapsed ? "Sign out" : undefined} onClick={() => void signOut()}>
              <LogOut />
              {collapsed ? <span className="sr-only">Sign out</span> : "Sign out"}
            </button>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Open menu">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="bg-sidebar">
                <SheetHeader>
                  <SheetTitle>Metarr</SheetTitle>
                  <div className="flex items-baseline justify-between gap-2 pr-8">
                    <p className="text-xs text-muted-foreground">{VERSION}</p>
                    <CpuReadout />
                  </div>
                </SheetHeader>
                <div className="flex flex-col gap-2 px-4">
                  <NavLinks onNavigate={() => setMenuOpen(false)} bump={bump} />
                  <button
                    type="button"
                    className={navItemClass(false)}
                    onClick={() => {
                      setMenuOpen(false);
                      openFolders();
                    }}
                  >
                    <FolderLock />
                    Fix folders
                  </button>
                  <button type="button" className={navItemClass(false)} onClick={() => void signOut()}>
                    <LogOut />
                    Sign out
                  </button>
                </div>
              </SheetContent>
            </Sheet>
            <p className="text-sm font-semibold">Metarr</p>
            <span className="text-xs text-muted-foreground">{VERSION}</span>
            <Button variant="ghost" size="sm" className="text-muted-foreground" asChild>
              <Link href="/tasks">
                <ListTodo />
                Tasks
                <TaskCount bump={bump} className="text-xs" />
              </Link>
            </Button>
          </header>
          <StuckToolsWarning />
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </div>
      </div>
      <Dialog open={maskOpen} onOpenChange={setMaskOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Folder permissions</DialogTitle>
            <DialogDescription>
              Folders Plex cannot list. The check opens them for everyone else, then looks again. The owner and group stay as they are.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {maskResult ? <p className="text-sm">{maskResult}</p> : null}
            {closedPaths == null ? (
              <p className="text-sm text-muted-foreground">Reading the stored folders…</p>
            ) : closedPaths.length === 0 ? (
              <p className="text-sm text-muted-foreground">No closed folder is stored. Run the check to look again.</p>
            ) : (
              <ul className="max-h-64 overflow-auto rounded-lg border px-3 py-2 font-mono text-xs leading-5">
                {closedPaths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {maskFailures.length ? (
              <ul className="max-h-32 overflow-auto text-xs leading-5 text-destructive">
                {maskFailures.map((item) => (
                  <li key={`${item.path}:${item.error}`}>
                    {item.path}: {item.error}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMaskOpen(false)}>
              Close
            </Button>
            <Button disabled={maskBusy} onClick={() => void fixFolders()}>
              {maskBusy ? "Checking folders…" : "Check and correct"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Sync metadata</DialogTitle>
            <DialogDescription>
              Metarr reads Plex, Radarr, Sonarr, and Bazarr. Folder scan, when it is on, reads the files and compares their language tags. A connector that fails keeps the last successful copy.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {(status?.connectors ?? []).map((connector) => {
              const percent =
                connector.total && connector.total > 0
                  ? Math.min(100, Math.round((connector.fetched / connector.total) * 100))
                  : connector.state === "success"
                    ? 100
                    : 0;
              return (
                <div key={connector.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">{CONNECTOR_LABEL[connector.id]}</span>
                    <span className="text-xs text-muted-foreground capitalize">{connector.state}</span>
                  </div>
                  <Progress value={connector.state === "skipped" ? 0 : percent} />
                  <p className="text-xs leading-5 text-muted-foreground">{connector.message}</p>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            {status?.running ? (
              <Button variant="outline" onClick={() => void cancelSync()}>
                Cancel sync
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setSyncOpen(false)}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ShellContext.Provider>
  );
}
