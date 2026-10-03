import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyEpisodeRename, filenameEpisodeTitle, hasSonarrCode, planEpisodeRename, sonarrEpisodeBasename } from "@/lib/episode-rename";

test("a Sonarr name uses the episode code and the English title", () => {
  assert.equal(
    sonarrEpisodeBasename("TaleSpin", 1, 7, "Time Waits for No Bear", ".avi"),
    "TaleSpin - S01E07 - Time Waits for No Bear.avi",
  );
  assert.equal(hasSonarrCode("/tv/TaleSpin/TaleSpin - S01E07 - Time Waits for No Bear.avi", 1, 7), true);
  assert.equal(hasSonarrCode("/tv/TaleSpin/4.-a villámkő titka 4.avi", 1, 4), false);
});

test("a Hungarian file is renamed beside its sidecar, and a file that already has the code stays", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-rename-"));
  const video = path.join(directory, "4.-a villámkő titka 4.avi");
  const subtitle = path.join(directory, "4.-a villámkő titka 4.hun.srt");
  fs.writeFileSync(video, "video");
  fs.writeFileSync(subtitle, "subtitle");
  const names = fs.readdirSync(directory);
  const planned = planEpisodeRename({
    filePath: video,
    seriesTitle: "TaleSpin",
    match: { season: 1, episode: 4, title: "Plunder & Lightning (4)" },
    namesInFolder: names,
  });
  assert.ok(planned.plan);
  applyEpisodeRename(planned.plan);
  const renamed = fs.readdirSync(directory).sort();
  assert.deepEqual(renamed, [
    "TaleSpin - S01E04 - Plunder & Lightning (4).avi",
    "TaleSpin - S01E04 - Plunder & Lightning (4).hun.srt",
  ]);
  const kept = planEpisodeRename({
    filePath: planned.plan.video.to,
    seriesTitle: "TaleSpin",
    match: { season: 1, episode: 4, title: "Plunder & Lightning (4)" },
    namesInFolder: renamed,
  });
  assert.equal(kept.plan, null);
  assert.equal(kept.reason, "keep");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("the file name uses the English title when the library row still has the local name", () => {
  assert.equal(filenameEpisodeTitle("Amit ma megtehetsz", "Time Waits for No Bear"), "Time Waits for No Bear");
  assert.equal(filenameEpisodeTitle("Time Waits for No Bear", "Time Waits for No Bear"), "Time Waits for No Bear");
  assert.equal(filenameEpisodeTitle("Amit ma megtehetsz", ""), "Amit ma megtehetsz");
});

test("a taken Sonarr name is not overwritten", () => {
  const planned = planEpisodeRename({
    filePath: "/tv/TaleSpin/4.-a villámkő titka 4.avi",
    seriesTitle: "TaleSpin",
    match: { season: 1, episode: 4, title: "Plunder & Lightning (4)" },
    namesInFolder: ["4.-a villámkő titka 4.avi", "TaleSpin - S01E04 - Plunder & Lightning (4).avi"],
  });
  assert.equal(planned.plan, null);
  assert.equal(planned.reason, "taken");
});
