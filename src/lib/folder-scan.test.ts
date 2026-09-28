import assert from "node:assert/strict";
import test from "node:test";
import { chooseMatch, cleanRoots, folderDraft, tracksFromProbe } from "@/lib/folder-scan";
import { sourceDraft } from "@/lib/source";

test("a probe report becomes audio and subtitle tracks in file order", () => {
  const probed = tracksFromProbe({
    streams: [
      { codec_type: "video", codec_name: "h264" },
      { codec_type: "audio", codec_name: "ac3", tags: { language: "por" } },
      { codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle", tags: { language: "ces" } },
    ],
  });
  assert.equal(probed?.audio[0]?.language, "Portuguese");
  assert.equal(probed?.audio[0]?.fromFile, true);
  assert.equal(probed?.audio[0]?.streamIndex, 0);
  assert.equal(probed?.subtitles[0]?.language, "Czech");
  assert.equal(probed?.subtitles[0]?.format, "PGS");
});

test("a scanned file takes the Radarr identity for the same path", () => {
  const radarr = sourceDraft({
    connector: "radarr",
    kind: "movie",
    externalKey: "12",
    title: "The Adjustment Bureau",
    year: 2011,
    imdbId: "tt1385826",
    path: "/mnt/media/Movies/The Adjustment Bureau (2011)/50201.m2ts",
  });
  const plex = sourceDraft({
    connector: "plex",
    kind: "movie",
    externalKey: "item:1",
    title: "The Adjustment Bureau",
    year: 2011,
    path: "/mnt/media/Movies/The Adjustment Bureau (2011)/50201.m2ts",
  });
  const match = chooseMatch([plex, radarr], "/mnt/media/Movies/The Adjustment Bureau (2011)/50201.m2ts");
  assert.equal(match?.connector, "radarr");
  const draft = folderDraft("/mnt/media/Movies/The Adjustment Bureau (2011)/50201.m2ts", {
    audio: [{ language: "Portuguese", layout: null, codec: null, streamIndex: 0, fromFile: true }],
    subtitles: [],
  }, match);
  assert.equal(draft.connector, "files");
  assert.equal(draft.imdbId, "tt1385826");
  assert.equal(draft.title, "The Adjustment Bureau");
  assert.equal(draft.files[0]?.audioTracks?.[0]?.language, "Portuguese");
  assert.throws(() => cleanRoots(["Movies"]), /full path/);
});
