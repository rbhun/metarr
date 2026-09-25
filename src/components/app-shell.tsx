"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { CONNECTOR_LABEL, type SyncStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Library, Menu, PanelLeftClose, PanelLeftOpen, RefreshCw, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

type ShellContextValue = {
  status: SyncStatus | null;
  epoch: number;
  startSync: () => Promise<void>;
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
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLinks({ onNavigate, collapsed = false }: { onNavigate?: () => void; collapsed?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            aria-label={item.label}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm",
              collapsed && "justify-center px-2",
              active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
            )}
          >
            <Icon />
            {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
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
    if (!response.ok) return;
    const next = (await response.json()) as SyncStatus;
    setStatus((previous) => {
      if (previous?.running && !next.running) bump();
      return next;
    });
  }, [bump]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!status?.running && !syncOpen) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 800);
    return () => window.clearInterval(timer);
  }, [refresh, status?.running, syncOpen]);

  const startSync = useCallback(async () => {
    setSyncOpen(true);
    await fetch("/api/sync", { method: "POST" });
    await refresh();
  }, [refresh]);

  return (
    <ShellContext.Provider value={{ status, epoch, startSync, bump }}>
      <div className="flex h-dvh bg-background text-foreground">
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex",
            collapsed ? "w-14" : "w-60",
          )}
        >
          <div className={cn("flex items-start gap-2 py-4", collapsed ? "justify-center px-2" : "px-4")}>
            {collapsed ? null : (
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold tracking-tight">Metarr</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Metadata for Plex, Radarr, Sonarr, and Bazarr.</p>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </div>
          <div className={cn(collapsed ? "px-2" : "px-3")}>
            <NavLinks collapsed={collapsed} />
          </div>
          <div className={cn("mt-auto space-y-3", collapsed ? "p-2" : "p-3")}>
            <Button
              className={cn(collapsed ? "w-full px-0" : "w-full")}
              aria-label={status?.running ? "Syncing" : "Sync metadata"}
              onClick={() => void startSync()}
              disabled={status?.running}
            >
              <RefreshCw className={status?.running ? "animate-spin" : undefined} />
              {collapsed ? <span className="sr-only">{status?.running ? "Syncing" : "Sync metadata"}</span> : status?.running ? "Syncing" : "Sync metadata"}
            </Button>
            {collapsed ? null : (
              <p className="px-1 text-[11px] leading-4 text-muted-foreground">
                Metadata only. Video files stay on your servers.
              </p>
            )}
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
                </SheetHeader>
                <div className="px-4">
                  <NavLinks onNavigate={() => setMenuOpen(false)} />
                </div>
                <div className="mt-auto p-4">
                  <Button className="w-full" onClick={() => void startSync()} disabled={status?.running}>
                    <RefreshCw className={status?.running ? "animate-spin" : undefined} />
                    {status?.running ? "Syncing" : "Sync metadata"}
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
            <p className="text-sm font-semibold">Metarr</p>
            <Button className="ml-auto" size="sm" onClick={() => void startSync()} disabled={status?.running}>
              <RefreshCw className={status?.running ? "animate-spin" : undefined} />
              Sync
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </div>
      </div>
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Sync metadata</DialogTitle>
            <DialogDescription>
              Metarr reads library records only. A connector that fails keeps the last successful copy.
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
        </DialogContent>
      </Dialog>
    </ShellContext.Provider>
  );
}
