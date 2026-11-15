import { LoginForm } from "@/components/login-form";
import { Suspense } from "react";

export default function SetupPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <LoginForm mode="setup" />
    </Suspense>
  );
}
