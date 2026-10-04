import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyEpisodeRename, episodeRenameTarget, filenameEpisodeTitle, hasSonarrCode, planEpisodeRename, sonarrEpisodeBasename } from "@/lib/episode-rename";

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

test("a correct episode name with a bad season or episode number is renamed", () => {
  const titles = {
    hu: { "1:7": "Amit ma megtehetsz" },
    en: { "1:7": "Time Waits for No Bear" },
  };
  const fromFile = episodeRenameTarget({
    filePath: "/tv/TaleSpin/TaleSpin - S02E03 - Time Waits for No Bear.avi",
    episodeTitles: titles,
    language: "hu",
    catalog: [{ season: 2, episode: 3, title: "Time Waits for No Bear" }],
  });
  assert.deepEqual(fromFile, { season: 1, episode: 7, title: "Time Waits for No Bear" });
  const echoed = episodeRenameTarget({
    filePath: "/tv/TaleSpin/Show - S02E03 - Amit ma megtehetsz.avi",
    episodeTitles: titles,
    language: "hu",
    catalog: [{ season: 2, episode: 3, title: "Time Waits for No Bear" }],
  });
  assert.deepEqual(echoed, { season: 1, episode: 7, title: "Time Waits for No Bear" });
  const sonarrOrder = episodeRenameTarget({
    filePath: "/dvd/12 - Amit ma megtehetsz.avi",
    episodeTitles: titles,
    language: "hu",
    catalog: [{ season: 1, episode: 14, title: "Time Waits for No Bear" }],
  });
  assert.deepEqual(sonarrOrder, { season: 1, episode: 14, title: "Time Waits for No Bear" });
  const fromSonarr = episodeRenameTarget({
    filePath: "/tv/TaleSpin/Balu kapitány kalandjai - S01E07 - Amit ma megtehetsz.avi",
    episodeTitles: titles,
    language: "hu",
    catalog: [{ season: 1, episode: 7, title: "Time Waits for No Bear" }],
    sonarrEpisodes: [{ season: 1, episode: 14, title: "Time Waits for No Bear" }],
  });
  assert.deepEqual(fromSonarr, { season: 1, episode: 14, title: "Time Waits for No Bear" });
  const wrongSeries = planEpisodeRename({
    filePath: "/tv/TaleSpin/Balu - S01E14 - Time Waits for No Bear.avi",
    seriesTitle: "TaleSpin",
    match: { season: 1, episode: 14, title: "Time Waits for No Bear" },
    namesInFolder: ["Balu - S01E14 - Time Waits for No Bear.avi"],
  });
  assert.equal(wrongSeries.plan?.video.to, "/tv/TaleSpin/TaleSpin - S01E14 - Time Waits for No Bear.avi");
  const kept = planEpisodeRename({
    filePath: "/tv/TaleSpin/TaleSpin - S01E14 - Time Waits for No Bear 1080p.avi",
    seriesTitle: "TaleSpin",
    match: { season: 1, episode: 14, title: "Time Waits for No Bear" },
    namesInFolder: ["TaleSpin - S01E14 - Time Waits for No Bear 1080p.avi"],
  });
  assert.equal(kept.plan, null);
  assert.equal(kept.reason, "keep");
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
