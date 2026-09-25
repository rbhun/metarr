import { testBazarr } from "@/lib/connectors/bazarr";
import { testPlex } from "@/lib/connectors/plex";
import { testRadarr } from "@/lib/connectors/radarr";
import { testSonarr } from "@/lib/connectors/sonarr";
import type { ConnectorId } from "@/lib/types";

export async function testConnector(id: ConnectorId, baseUrl: string, apiKey: string): Promise<string> {
  if (!baseUrl.trim()) throw new Error("Enter a base URL.");
  if (!apiKey.trim()) {
    throw new Error(id === "plex" ? "Enter a Plex token." : "Enter an API key.");
  }
  if (id === "plex") return testPlex(baseUrl, apiKey);
  if (id === "radarr") return testRadarr(baseUrl, apiKey);
  if (id === "sonarr") return testSonarr(baseUrl, apiKey);
  return testBazarr(baseUrl, apiKey);
}
