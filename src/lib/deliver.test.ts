import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePlexSections, plexScanTarget, radarrMovieFor, sonarrSeriesFor } from "@/lib/announce";
import { deliverFile, partialPath } from "@/lib/deliver";

function scratch(): { root: string; source: string; target: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-deliver-"));
  const source = path.join(root, "work.mkv");
  fs.writeFileSync(source, "new");
  return { root, source, target: path.join(root, "Film.mkv") };
}

test("a delivered file arrives complete, group-writable, and without a leftover .partial", () => {
  const { root, source, target } = scratch();
  try {
    deliverFile(source, target);
    assert.equal(fs.readFileSync(target, "utf8"), "new");
    assert.equal(fs.statSync(target).mode & 0o777, 0o664);
    assert.equal(fs.existsSync(partialPath(target)), false);
    assert.equal(fs.existsSync(source), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("delivery never overwrites an existing file or removes a .partial it did not create", () => {
  const { root, source, target } = scratch();
  try {
    fs.writeFileSync(target, "old");
    assert.throws(() => deliverFile(source, target), /already exists/);
    assert.equal(fs.readFileSync(target, "utf8"), "old");
    fs.rmSync(target);
    fs.writeFileSync(partialPath(target), "someone else");
    assert.throws(() => deliverFile(source, target), /left over/);
    assert.equal(fs.readFileSync(partialPath(target), "utf8"), "someone else");
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a replacing delivery swaps the file in with the requested mode", () => {
  const { root, source, target } = scratch();
  try {
    fs.writeFileSync(target, "old");
    deliverFile(source, target, { replace: true, mode: 0o664 });
    assert.equal(fs.readFileSync(target, "utf8"), "new");
    assert.equal(fs.existsSync(partialPath(target)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rescans reach only the Plex section, Radarr movie, and Sonarr series that own the folder", () => {
  const sections = parsePlexSections({
    MediaContainer: {
      Directory: [
        { key: "1", Location: [{ path: "/mnt/media/Movies" }] },
        { key: "2", Location: [{ path: "/mnt/media/TV" }] },
        { key: "3", Location: [{ path: "/mnt/media" }] },
      ],
    },
  });
  const folder = "/mnt/media/Movies/50 First Dates (2004)";
  assert.deepEqual(plexScanTarget(sections, [folder]), { key: "1", folder });
  assert.equal(plexScanTarget(sections, ["/mnt/other/Film"]), null);
  assert.equal(plexScanTarget(sections, ["/mnt/media/Movies2/Film"])?.key, "3");
  assert.equal(radarrMovieFor([{ id: 7, path: "/mnt/media/Movies/Heat (1995)" }, { id: 9, path: `${folder}/` }], [folder]), 9);
  assert.equal(radarrMovieFor([{ id: 7, path: "/mnt/media/Movies/50 First Dates" }], [folder]), null);
  assert.equal(sonarrSeriesFor([{ id: 4, path: "/mnt/media/TV/Lost" }], ["/mnt/media/TV/Lost/Season 1"]), 4);
  assert.equal(sonarrSeriesFor([{ id: 4, path: "/mnt/media/TV/Lost" }], ["/mnt/media/TV/Lost Girl"]), null);
});
