"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AuthRequired } from "@/lib/auth";
import { toast } from "sonner";
import { useEffect, useState, type FormEvent } from "react";

export function AuthSettingsCard() {
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [required, setRequired] = useState<AuthRequired>("enabled");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let gone = false;
    void (async () => {
      const response = await fetch("/api/auth", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { username?: string; required?: AuthRequired };
      if (gone) return;
      setUsername(body.username ?? "");
      setRequired(body.required === "local" ? "local" : "enabled");
    })();
    return () => {
      gone = true;
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, currentPassword, newPassword, required }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "The login could not be saved.");
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Login saved. Other browsers need to sign in again.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The login could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Login</CardTitle>
        <CardDescription>
          One username and password for this server, the same way Radarr and Sonarr do it. The password is stored as a hash. Saving signs other browsers out.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void save(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="auth-username">Username</Label>
            <Input
              id="auth-username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auth-required">Authentication required</Label>
            <select
              id="auth-required"
              value={required}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              onChange={(event) => setRequired(event.target.value === "local" ? "local" : "enabled")}
            >
              <option value="enabled">Enabled</option>
              <option value="local">Disabled for local addresses</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auth-current">Current password</Label>
            <Input
              id="auth-current"
              name="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auth-new">New password</Label>
            <Input
              id="auth-new"
              name="new-password"
              type="password"
              autoComplete="new-password"
              placeholder="Leave blank to keep the current password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
            Disabled for local addresses skips the login when the connection is from this machine. A browser that opens the published port from another device still signs in.
          </p>
          <div>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : "Save login"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
