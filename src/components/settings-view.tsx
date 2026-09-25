"use client";

import { useShell } from "@/components/app-shell";
import { DetectSettingsCard } from "@/components/detect-settings";
import { RemuxSettingsCard } from "@/components/remux-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_PORT, normalizeBaseUrl } from "@/lib/connectors/http";
import { formatWhen } from "@/lib/format";
import { TITLE_LANGUAGES } from "@/lib/title-language";
import { CONNECTOR_LABEL, PROVIDER_LABEL, type ConnectorId, type ConnectorSettings, type ProviderId, type ProviderSettings } from "@/lib/types";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";

const HELP: Record<ConnectorId, { url: string; secret: string; body: string }> = {
  plex: {
    url: "http://192.168.1.20:32400",
    secret: "X-Plex-Token",
    body: "Paste the server URL and an X-Plex-Token. Metarr does not ask for a Plex username or password.",
  },
  radarr: {
    url: "http://192.168.1.20:7878",
    secret: "API key",
    body: "Radarr → Settings → General → API Key. Requests use the v3 API and the X-Api-Key header.",
  },
  sonarr: {
    url: "http://192.168.1.20:8989",
    secret: "API key",
    body: "Sonarr → Settings → General → API Key. Requests use the v3 API and the X-Api-Key header.",
  },
  bazarr: {
    url: "http://192.168.1.20:6767",
    secret: "API key",
    body: "Bazarr → Settings → General → API Key. Movies and episode subtitles are read with X-Api-Key.",
  },
};

type FormState = {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
};

const PROVIDER_HELP: Record<ProviderId, { secret: string; body: string }> = {
  tmdb: {
    secret: "TMDB API key",
    body: "Free key from themoviedb.org. Used for posters, overviews, runtime, genres, and IDs when your servers leave those blank.",
  },
  omdb: {
    secret: "OMDb API key",
    body: "Key from omdbapi.com. Used for the IMDb rating and as a fallback plot and poster when TMDB has no match. The free key allows 1,000 lookups per UTC day; Metarr stops there.",
  },
};

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error || body?.message || `Request failed (${response.status}).`;
}

export function SettingsView() {
  const { bump } = useShell();
  const [forms, setForms] = useState<Partial<Record<ConnectorId, FormState>>>({});
  const [saved, setSaved] = useState<ConnectorSettings[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Partial<Record<ConnectorId, boolean>>>({});
  const [providers, setProviders] = useState<Partial<Record<ProviderId, { apiKey: string; enabled: boolean }>>>({});
  const [providerReveal, setProviderReveal] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [omdbUsed, setOmdbUsed] = useState<number | null>(null);
  const [plexLibraries, setPlexLibraries] = useState<Array<{ key: string; title: string; type: "movie" | "show"; included: boolean }> | null>(null);
  const [plexLibrariesOpen, setPlexLibrariesOpen] = useState(false);
  const [plexLibraryError, setPlexLibraryError] = useState<string | null>(null);
  const [titleLanguage, setTitleLanguage] = useState("");
  const [fileBrowserUrl, setFileBrowserUrl] = useState("");
  const [fileBrowserRoot, setFileBrowserRoot] = useState("");

  async function refreshSaved() {
    const response = await fetch("/api/connectors", { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { connectors: ConnectorSettings[] };
    setSaved(body.connectors);
  }

  async function loadPlexLibraries() {
    setPlexLibraryError(null);
    const response = await fetch("/api/plex/libraries", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      libraries?: Array<{ key: string; title: string; type: "movie" | "show"; included: boolean }>;
    } | null;
    if (!response.ok) {
      setPlexLibraries(null);
      setPlexLibraryError(body?.error || "Plex libraries could not be loaded.");
      return;
    }
    setPlexLibraries(body?.libraries ?? []);
  }

  async function savePlexLibraries() {
    if (!plexLibraries) return;
    setBusy("plex-libraries");
    try {
      const response = await fetch("/api/plex/libraries", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: plexLibraries.filter((library) => !library.included).map((library) => library.key) }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("Plex library selection saved. The next sync skips the ones you turned off.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save the library selection.");
    } finally {
      setBusy(null);
    }
  }

  async function load() {
    setError(null);
    try {
      const response = await fetch("/api/connectors", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { connectors: ConnectorSettings[] };
      setSaved(body.connectors);
      setForms(
        Object.fromEntries(
          body.connectors.map((connector) => [
            connector.id,
            { baseUrl: connector.baseUrl, apiKey: connector.apiKey, enabled: connector.enabled },
          ]),
        ),
      );
      const providerResponse = await fetch("/api/providers", { cache: "no-store" });
      if (providerResponse.ok) {
        const providerBody = (await providerResponse.json()) as {
          providers: ProviderSettings[];
          omdb?: { count: number };
        };
        setProviders(
          Object.fromEntries(providerBody.providers.map((provider) => [provider.id, { apiKey: provider.apiKey, enabled: provider.enabled }])),
        );
        if (typeof providerBody.omdb?.count === "number") setOmdbUsed(providerBody.omdb.count);
      }
      const preferenceResponse = await fetch("/api/preferences", { cache: "no-store" });
      if (preferenceResponse.ok) {
        const preferenceBody = (await preferenceResponse.json()) as {
          titleLanguage?: string;
          fileBrowserUrl?: string;
          fileBrowserRoot?: string;
        };
        setTitleLanguage(preferenceBody.titleLanguage ?? "");
        setFileBrowserUrl(preferenceBody.fileBrowserUrl ?? "");
        setFileBrowserRoot(preferenceBody.fileBrowserRoot ?? "");
      }
      const plex = body.connectors.find((connector) => connector.id === "plex");
      if (plex?.baseUrl && plex.apiKey) await loadPlexLibraries();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function update(id: ConnectorId, patch: Partial<FormState>) {
    setForms((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }));
  }

  async function save(id: ConnectorId) {
    const form = forms[id];
    if (!form) return;
    setBusy(`save:${id}`);
    try {
      const response = await fetch("/api/connectors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...form }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { connectors: ConnectorSettings[] };
      setSaved(body.connectors);
      const stored = body.connectors.find((connector) => connector.id === id);
      if (stored) update(id, { baseUrl: stored.baseUrl });
      toast.success(`${CONNECTOR_LABEL[id]} saved on this machine.`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  }

  async function test(id: ConnectorId) {
    const form = forms[id];
    if (!form) return;
    setBusy(`test:${id}`);
    try {
      const response = await fetch("/api/connectors/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, baseUrl: form.baseUrl, apiKey: form.apiKey }),
      });
      const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (!response.ok) throw new Error(body?.message || body?.error || "Connection failed.");
      toast.success(body?.message || "Connected.");
      await refreshSaved();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Connection failed.");
      await refreshSaved();
    } finally {
      setBusy(null);
    }
  }

  async function saveProvider(id: ProviderId) {
    const form = providers[id];
    if (!form) return;
    setBusy(`provider:${id}`);
    try {
      const response = await fetch("/api/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, apiKey: form.apiKey, enabled: form.enabled }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { providers: ProviderSettings[] };
      setProviders(Object.fromEntries(body.providers.map((provider) => [provider.id, { apiKey: provider.apiKey, enabled: provider.enabled }])));
      toast.success(`${PROVIDER_LABEL[id]} saved on this machine.`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  }

  async function loadDemo() {
    setBusy("demo");
    try {
      const response = await fetch("/api/demo", { method: "POST" });
      if (!response.ok) throw new Error(await readError(response));
      bump();
      toast.success("Demo library loaded. No server was contacted.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not load the demo.");
    } finally {
      setBusy(null);
    }
  }

  async function clearStoredLibrary() {
    if (!window.confirm("Remove every title stored in Metarr? Addresses and keys stay. Nothing is deleted on Plex or the *arr apps.")) return;
    setBusy("clear-library");
    try {
      const response = await fetch("/api/library", { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      bump();
      toast.success("Library cleared. Server settings were kept.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The library could not be cleared.");
    } finally {
      setBusy(null);
    }
  }

  async function clearDemo() {
    setBusy("clear-demo");
    try {
      const response = await fetch("/api/demo", { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      bump();
      toast.success("Demo library cleared. Saved server settings are unchanged.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not clear the demo.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Paste each server you want to read. Unused apps stay disconnected and are left out of the “in all *arr” check.
            Keys live in the local SQLite file, not in the repository.
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm">
            <p>{error}</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : null}

        {loading ? <p className="text-sm text-muted-foreground">Loading saved connectors…</p> : null}

        <div className="grid gap-4 lg:grid-cols-2">
          {(Object.keys(HELP) as ConnectorId[]).map((id) => {
            const form = forms[id];
            const stored = saved.find((connector) => connector.id === id);
            const help = HELP[id];
            return (
              <Card key={id} size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {CONNECTOR_LABEL[id]}
                    {stored?.enabled && stored.baseUrl && stored.apiKey ? (
                      <Badge variant="secondary">Included in sync</Badge>
                    ) : (
                      <Badge variant="outline">Disconnected</Badge>
                    )}
                  </CardTitle>
                  <CardDescription>{help.body}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-url`}>Base URL</Label>
                    <Input
                      id={`${id}-url`}
                      value={form?.baseUrl ?? ""}
                      placeholder={help.url}
                      autoComplete="off"
                      onChange={(event) => update(id, { baseUrl: event.target.value })}
                      onBlur={() => {
                        const current = forms[id]?.baseUrl ?? "";
                        if (!current.trim()) return;
                        try {
                          update(id, { baseUrl: normalizeBaseUrl(current, DEFAULT_PORT[id]) });
                        } catch {
                          // Save and Test report the same validation error.
                        }
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-key`}>{help.secret}</Label>
                    <div className="flex gap-2">
                      <Input
                        id={`${id}-key`}
                        type={reveal[id] ? "text" : "password"}
                        value={form?.apiKey ?? ""}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => update(id, { apiKey: event.target.value })}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setReveal((current) => ({ ...current, [id]: !current[id] }))}
                      >
                        {reveal[id] ? "Hide" : "Show"}
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <Label htmlFor={`${id}-enabled`}>Include in sync</Label>
                    <Switch
                      id={`${id}-enabled`}
                      checked={form?.enabled ?? false}
                      onCheckedChange={(checked) => update(id, { enabled: checked })}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => void save(id)} disabled={!form || busy === `save:${id}`}>
                      Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void test(id)} disabled={!form || busy === `test:${id}`}>
                      Test connection
                    </Button>
                    {id === "plex" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        aria-expanded={plexLibrariesOpen}
                        onClick={() => setPlexLibrariesOpen((open) => !open)}
                      >
                        <ChevronRight className={`transition-transform ${plexLibrariesOpen ? "rotate-90" : ""}`} />
                        Libraries
                      </Button>
                    ) : null}
                  </div>
                  {id === "plex" && plexLibrariesOpen ? (
                    <div className="space-y-2 rounded-lg border px-3 py-2">
                      <p className="text-xs leading-5 text-muted-foreground">
                        Choose which movie and TV libraries to read. Music and photo libraries are never synced.
                      </p>
                      {plexLibraryError ? <p className="text-xs text-rose-700 dark:text-rose-300">{plexLibraryError}</p> : null}
                      {plexLibraries?.map((library) => (
                        <label key={library.key} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={library.included}
                            onCheckedChange={(value) =>
                              setPlexLibraries((current) =>
                                current?.map((item) => (item.key === library.key ? { ...item, included: value === true } : item)) ?? null,
                              )
                            }
                            aria-label={`Include ${library.title}`}
                          />
                          <span>{library.title}</span>
                          <span className="text-xs text-muted-foreground">{library.type === "movie" ? "Movies" : "Series"}</span>
                        </label>
                      ))}
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => void loadPlexLibraries()} disabled={busy === "plex-libraries"}>
                          Refresh libraries
                        </Button>
                        <Button size="sm" onClick={() => void savePlexLibraries()} disabled={!plexLibraries || busy === "plex-libraries"}>
                          Save library selection
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {stored?.lastTestMessage ? (
                    <p className="text-xs leading-5 text-muted-foreground">
                      Last test {formatWhen(stored.lastTestAt)}: {stored.lastTestMessage}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Not tested yet.</p>
                  )}
                  {stored?.lastSyncMessage ? (
                    <p className="text-xs leading-5 text-muted-foreground">
                      Last sync {formatWhen(stored.lastSyncAt)}: {stored.lastSyncMessage}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card size="sm">
            <CardHeader>
              <CardTitle>File Browser</CardTitle>
              <CardDescription>
                Opens the folder that contains a file. Paste the File Browser address, such as http://192.168.30.4:8080. If that app’s root is a folder rather than the whole disk, set the same path here so /mnt/media/Movies becomes /files/Movies.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="file-browser-url">Address</Label>
                <Input
                  id="file-browser-url"
                  value={fileBrowserUrl}
                  placeholder="http://192.168.30.4:8080"
                  onChange={(event) => setFileBrowserUrl(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="file-browser-root">Files start at</Label>
                <Input
                  id="file-browser-root"
                  value={fileBrowserRoot}
                  placeholder="/mnt/media"
                  onChange={(event) => setFileBrowserRoot(event.target.value)}
                />
              </div>
              <Button
                size="sm"
                disabled={busy === "file-browser"}
                onClick={() => {
                  setBusy("file-browser");
                  void fetch("/api/preferences", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ fileBrowserUrl, fileBrowserRoot }),
                  })
                    .then(async (response) => {
                      if (!response.ok) throw new Error(await readError(response));
                      const saved = (await response.json()) as { fileBrowserUrl?: string; fileBrowserRoot?: string };
                      setFileBrowserUrl(saved.fileBrowserUrl ?? "");
                      setFileBrowserRoot(saved.fileBrowserRoot ?? "");
                      bump();
                      toast.success(saved.fileBrowserUrl ? "File Browser links are on." : "File Browser links are off.");
                    })
                    .catch((caught: unknown) => {
                      toast.error(caught instanceof Error ? caught.message : "Could not save File Browser.");
                    })
                    .finally(() => setBusy(null));
                }}
              >
                Save
              </Button>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle>Secondary title</CardTitle>
              <CardDescription>
                Shows a title in the chosen language under the Plex title. The names come from TMDB during lookup and stay in the local database.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="title-language">Language</Label>
                <select
                  id="title-language"
                  value={titleLanguage}
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  onChange={(event) => setTitleLanguage(event.target.value)}
                >
                  <option value="">Off</option>
                  {TITLE_LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                size="sm"
                disabled={busy === "title-language"}
                onClick={() => {
                  setBusy("title-language");
                  void fetch("/api/preferences", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ titleLanguage }),
                  })
                    .then(async (response) => {
                      if (!response.ok) throw new Error(await readError(response));
                      bump();
                      toast.success(titleLanguage ? "Secondary titles will show after a lookup." : "Secondary titles are off.");
                    })
                    .catch((caught: unknown) => {
                      toast.error(caught instanceof Error ? caught.message : "Could not save the language.");
                    })
                    .finally(() => setBusy(null));
                }}
              >
                Save
              </Button>
            </CardContent>
          </Card>
        </div>

        <DetectSettingsCard />
        <RemuxSettingsCard />

        <div>
          <h2 className="text-base font-semibold tracking-tight">Online sources</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Lookups fill posters, overviews, runtime, and missing ratings or genres in Metarr. Results stay in the local database.
            Nothing is written back to Plex or the *arr apps.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {(Object.keys(PROVIDER_HELP) as ProviderId[]).map((id) => {
            const form = providers[id];
            const help = PROVIDER_HELP[id];
            return (
              <Card key={id} size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {PROVIDER_LABEL[id]}
                    {form?.enabled && form.apiKey ? <Badge variant="secondary">Used for lookup</Badge> : <Badge variant="outline">Off</Badge>}
                  </CardTitle>
                  <CardDescription>{help.body}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {id === "omdb" && form?.enabled ? (
                    <p className="text-xs text-muted-foreground">{omdbUsed ?? 0} of 1,000 lookups used today (UTC).</p>
                  ) : null}
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-key`}>{help.secret}</Label>
                    <div className="flex gap-2">
                      <Input
                        id={`${id}-key`}
                        type={providerReveal[id] ? "text" : "password"}
                        value={form?.apiKey ?? ""}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) =>
                          setProviders((current) => ({ ...current, [id]: { apiKey: event.target.value, enabled: current[id]?.enabled ?? false } }))
                        }
                      />
                      <Button type="button" variant="outline" onClick={() => setProviderReveal((current) => ({ ...current, [id]: !current[id] }))}>
                        {providerReveal[id] ? "Hide" : "Show"}
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <Label htmlFor={`${id}-enabled`}>Use when looking up</Label>
                    <Switch
                      id={`${id}-enabled`}
                      checked={form?.enabled ?? false}
                      onCheckedChange={(checked) =>
                        setProviders((current) => ({ ...current, [id]: { apiKey: current[id]?.apiKey ?? "", enabled: checked } }))
                      }
                    />
                  </div>
                  <Button size="sm" onClick={() => void saveProvider(id)} disabled={!form || busy === `provider:${id}`}>
                    Save
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Stored library</CardTitle>
            <CardDescription>
              Clear removes the titles, episode rows, and online notes kept in the local database. Saved server addresses and keys stay.
              Plex and the *arr apps are not changed. Sync again to refill the table.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm" variant="outline" onClick={() => void clearStoredLibrary()} disabled={busy === "clear-library"}>
              Clear library
            </Button>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Demo library</CardTitle>
            <CardDescription>
              Load a labeled sample — The Godfather, a file-less Part II, a disc image, HDR, and a series with a missing episode —
              so the table can be tried before a server answers. This does not call Plex or the *arr apps, and it does not change saved URLs or keys.
              A later successful sync replaces the sample.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void loadDemo()} disabled={busy === "demo"}>
              Load demo library
            </Button>
            <Button size="sm" variant="outline" onClick={() => void clearDemo()} disabled={busy === "clear-demo"}>
              Clear demo data
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
