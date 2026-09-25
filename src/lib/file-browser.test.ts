import assert from "node:assert/strict";
import test from "node:test";
import { fileBrowserHref } from "@/lib/file-browser";

test("file browser opens the folder that contains the file", () => {
  assert.equal(
    fileBrowserHref(
      "http://192.168.30.4:8080",
      "/mnt/media/Movies/Tenet (2020)/Tenet.2020.IMAX.2160p.mkv",
    ),
    "http://192.168.30.4:8080/files/mnt/media/Movies/Tenet%20(2020)/",
  );
});

test("a scope root is removed so the link matches File Browser's files root", () => {
  assert.equal(
    fileBrowserHref(
      "http://192.168.30.4:8080/",
      "/mnt/media/Movies/Tenet (2020)/Tenet.mkv",
      "/mnt/media",
    ),
    "http://192.168.30.4:8080/files/Movies/Tenet%20(2020)/",
  );
  assert.equal(fileBrowserHref("http://192.168.30.4:8080", "/other/Tenet.mkv", "/mnt/media"), null);
  assert.equal(fileBrowserHref("", "/mnt/media/Tenet.mkv"), null);
});
