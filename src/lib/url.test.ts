import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBaseUrl } from "@/lib/connectors/http";

test("a bare IP gets http and the app port", () => {
  assert.equal(normalizeBaseUrl("192.168.1.20", 32400), "http://192.168.1.20:32400");
  assert.equal(normalizeBaseUrl("192.168.1.20", 7878), "http://192.168.1.20:7878");
  assert.equal(normalizeBaseUrl("192.168.1.20", 8989), "http://192.168.1.20:8989");
  assert.equal(normalizeBaseUrl("192.168.1.20", 6767), "http://192.168.1.20:6767");
});

test("an explicit port or scheme is kept", () => {
  assert.equal(normalizeBaseUrl("192.168.1.20:7879", 7878), "http://192.168.1.20:7879");
  assert.equal(normalizeBaseUrl("https://plex.local", 32400), "https://plex.local:32400");
  assert.equal(normalizeBaseUrl("https://plex.local:443", 32400), "https://plex.local");
  assert.equal(normalizeBaseUrl("http://192.168.1.20:80", 32400), "http://192.168.1.20");
});
