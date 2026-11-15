"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VERSION } from "@/lib/version";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${response.status}).`;
}

export function LoginForm({ mode }: { mode: "login" | "setup" }) {
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = mode === "setup";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (setup && password !== confirm) {
      setError("Those passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(setup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          setup
            ? { username, password }
            : { username, password, remember, next: params.get("next") },
        ),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { next?: string };
      window.location.assign(body.next || "/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.");
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Metarr</CardTitle>
        <CardDescription>
          {setup
            ? "Create the login for this server. One username and password, the same way Radarr and Sonarr do it. It stays in the local database."
            : "Sign in. This login is for this Metarr server."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={setup ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
            />
          </div>
          {setup ? (
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Password again</Label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
                minLength={8}
              />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Checkbox id="remember" checked={remember} onCheckedChange={(value) => setRemember(value === true)} />
              <Label htmlFor="remember">Remember me</Label>
            </div>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={busy}>
            {busy ? (setup ? "Creating…" : "Signing in…") : setup ? "Create login" : "Sign in"}
          </Button>
          <p className="text-xs text-muted-foreground">{VERSION}</p>
        </form>
      </CardContent>
    </Card>
  );
}
