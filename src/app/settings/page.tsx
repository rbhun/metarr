import { SettingsView } from "@/components/settings-view";
import { enforceAppAccess } from "@/lib/page-guard";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await enforceAppAccess();
  return <SettingsView />;
}
