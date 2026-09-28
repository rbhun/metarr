# Changes

## 0.0.81

- Keep the Syncing button clickable so a scan that is already running can be opened and watched.

## 0.0.80

- Write a recognized audio language into the AVI that is already there, instead of creating an MKV.

## 0.0.79

- A numbered disc stream such as 00000.m2ts takes the movie folder it is in, and the other streams in that folder stay with that movie.

## 0.0.78

- Copy an AVI into an MKV when a track language is recognized, because an AVI cannot store one and Plex would keep showing unknown.

## 0.0.77

- Match a scanned file to the movie or episode that already owns its folder, so a disc stream or a differently named episode is not listed as its own movie.

## 0.0.76

- Put a Sync button on folder scan, in the source cards, so those folders can be read on their own.

## 0.0.75

- Show each video file's length, even when two copies of the same title match.

## 0.0.74

- Fill an empty folder scan list from the movie and show folders Plex is already watching.

## 0.0.73

- A file tooltip names Radarr or Sonarr, not both, because a movie and an episode do not share those apps.

## 0.0.72

- Show a source tooltip on a language and on the file-type pill, using the labels already stored for that title.

## 0.0.71

- Show a short file or audio track as its own pill, instead of writing short into the audio name.

## 0.0.70

- Label a finished rip as Saved (or Dry run) on Tasks, instead of "No language", which only applies to language checks.
- Fix the build after the folder scan source was added, so the Docker image compiles again.

## 0.0.69

- Hover a language to see whether Plex, Radarr or Sonarr, and the folder scan have that label.

## 0.0.68

- Put the schedule cards in the two-column settings layout, with a divider after them and another before the stored library.

## 0.0.67

- Add a folder scan, off until it is enabled in Settings, that reads language tags from the files and marks where they disagree with Plex or Radarr and Sonarr.

## 0.0.66

- Resync the library on a timer from Settings, and keep Sync now there with the other schedules.

## 0.0.65

- Read the language code Plex sends with a track, so a name written in another language is not stored as unknown.

## 0.0.64

- Load the full Plex record when an audio track has no language, and fill a blank track from Radarr or Sonarr when their list lines up, so a language both sources already have is not shown as unknown.

## 0.0.63

- Sync the library two minutes after a remux finishes, so the title shows the new MKV instead of the DVD without a manual Sync.

## 0.0.62

- Read a language stored on an audio track when Plex left it blank, show that name in its own color, and mark a track that only lasts a moment before listening to it.

## 0.0.61

- Build MakeMKV 2.0.0 into the Docker image, because remux failed with exit code 127 when makemkvcon only existed on the host, and say plainly when it cannot be found.

## 0.0.60

- Put remux and retag scratch on the NAS in `/mnt/media/.metarr-work`, since the Plex VM has no room for a Blu-ray remux, and rename finished files into place instead of copying them again.

## 0.0.59

- Follow the host rules for media: run as 1500:1002 with umask 002, deliver files through `.partial`, keep scratch local, ask Plex and Radarr/Sonarr to rescan, and add a dry-run mode.

## 0.0.58

- Mount `/mnt/media` the same plain way as other containers, take the user from `.env`, and drop the NFS volume switching from deploy.

## 0.0.57

- Let deploy reset its generated docker-compose.media.yml before git pull so a prior NFS rewrite cannot block updates.

## 0.0.56

- Switch to direct NFS with a new `media_nfs` volume instead of recreating/deleting media volumes, so deploy cannot wipe library data.

## 0.0.55

- Recreate the media Docker volume without a y/N prompt when switching to a direct NFS mount.

## 0.0.54

- Fix the Docker build after forced-subtitle detection by only applying commentary roles to audio tracks.

## 0.0.53

- Call a disc track silent when it only holds a blank moment at the start, instead of saying the sample could not be read.

## 0.0.52

- Mark a subtitle as forced when a long film only has a few cues, the signs and titles rather than the dialogue.

## 0.0.51

- Read a picture subtitle from the times it actually has images, when the ten- and twenty-minute windows are empty.

## 0.0.50

- Read an external subtitle from Plex's file path, including one kept in a subs folder.

## 0.0.49

- Read a short slice of a Blu-ray file at the ten-minute mark, so a 4K disc is not scanned until the audio read runs out of time.

## 0.0.48

- If this host's /mnt/media returns EROFS while other NFS clients can write, mount the share directly into Docker (auto-detect or METARR_NFS_ADDR/EXPORT).

## 0.0.47

- When touch fails with EROFS even though findmnt shows rw, say the NFS/ZFS share is read-only on the NAS — UID/GID cannot fix that.

## 0.0.46

- Make clear that mount rw is not the same as Unix write permission, and that deploy only samples a folder — remux uses METARR_UID/GID for every disc.

## 0.0.45

- Probe remux write access inside a movie title folder (not Movies/), and show host vs container errors when NFS still denies writes.

## 0.0.44

- On NFS media shares, avoid running remux as root (root_squash) and probe write access in the Movies folder as the app user.

## 0.0.43

- Say clearly when disc remux fails because `/mnt/media` is mounted read-only (EROFS).

## 0.0.42

- Read a 4K disc's audio from where the stream starts, instead of reporting that the sample had no speech.

## 0.0.41

- Redo a failed task from Tasks, and put language detection and disc remux in half-width settings cards.

## 0.0.40

- Open Tasks links on the All list by default.

## 0.0.39

- Add an All filter on Tasks that shows waiting, running, done, and failed jobs in one list.

## 0.0.38

- Install util-linux in the image so remux can drop to the media owner with setpriv.

## 0.0.37

- Run the container as the media folder owner when possible, so remux can write the MKV beside a DVD.

## 0.0.36

- Fix the Docker image build after the remux path check failed TypeScript.

## 0.0.35

- Start a track as soon as you click Unknown, even when the overnight queue already has it.

## 0.0.34

- Mount `/mnt/media` for Docker remux, write temp files under the app data folder, and say clearly when the disc folder is missing inside Metarr.

## 0.0.33

- Keep the movie's file type when saving a language into an MP4, so the new file can be written.

## 0.0.32

- Copy a short piece of a PGS subtitle at 10 and 20 minutes, so a Blu-ray file is not read until ffmpeg gives up.

## 0.0.31

- Write a recognized language into the movie file, then ask Plex and the *arr apps to re-read it.

## 0.0.30

- Listen at 10 and 20 minutes, past the titles and the opening scene, when guessing an unknown audio track.

## 0.0.29

- Add a switch so disc remux can be turned off. Queued discs wait until it is on again.

## 0.0.28

- Clear a Tasks filter only after you confirm, and only the tracks in that filter.

## 0.0.27

- Mark a language check as failed when it does not name a language, including when the text was never read.

## 0.0.26

- Mark a subtitle that Plex did not name as failed, because the video was never read as text.

## 0.0.25

- Show every language check in one Tasks list, colored by what it is doing, with filters when you want only one state.

## 0.0.24

- Show disc remux jobs on Tasks with the failure reason, and keep Rips for sending discs.

## 0.0.23

- Add a Rips page to send ISO and DVD disc images for high-quality MakeMKV remuxes, with queue history.

## 0.0.22

- Open language checks on their own page, with pages of history and the reason a track failed.

## 0.0.21

- Use the movie or episode title for the multi-part pill, so the image build can finish.

## 0.0.20

- Mark a split movie, named like 1 of 2 or CD1, with a pill that says which part it is.

## 0.0.19

- Show finished and failed language checks in Tasks, and add a way to clear the tracks still waiting.

## 0.0.18

- Mark a commentary when one behind-the-camera phrase is heard, and listen again to a detected stereo or mono track.

## 0.0.17

- Listen to one short clip just after the opening, so a Dolby Digital file is not read for minutes before Whisper starts.

## 0.0.16

- On a surround track, listen to the center and the front left and right, about 70% from the center, and leave the surrounds out.
- Read the letters on a picture subtitle instead of the gray box behind them, and keep short lines such as the ones in 1917.

## 0.0.15

- Take an unknown audio sample from the first minutes of the file, and keep the Dolby Digital packets in that window, so a seek does not come back empty.

## 0.0.14

- Read picture subtitles from several points in the film and try French and Spanish as well, so a quiet stretch is not mistaken for an unreadable language.

## 0.0.13

- Show the subtitle file next to the video first, under its English language name, even when the file name does not match the video. The picture-subtitle reader typechecks so the image build can finish.

## 0.0.12

- One click on a series Unknown checks every episode that still has that track, and the episode list updates when a check finishes.

## 0.0.11

- Copy a PGS track out of the video instead of decoding the movie, and crop a VobSub picture down to the text.

## 0.0.10

- Read PGS and VobSub pictures by drawing each bitmap as an image before guessing the language.

## 0.0.9

- Attach a Hungarian sidecar when Plex calls it Magyar, and show whether a subtitle is SRT, PGS, or VobSub.

## 0.0.8

- Read a Hungarian subtitle saved in Central European encoding, and accept it when it is clearly ahead of the next guess.

## 0.0.7

- Leave a subtitle Unknown when the language match is too weak to trust.

## 0.0.6

- Open Tasks from the corner note after you start a language check.

## 0.0.5

- Match an untagged subtitle to the sidecar beside the video, and do not read the video itself as text.

## 0.0.4

- Write picture-subtitle frames as PNG so ffmpeg does not fail while choosing an encoder.

## 0.0.3

- Make Library, Tasks, and Settings the same sidebar row, with Settings last.

## 0.0.2

- Add `deploy.sh` so an SSH session can pull and rebuild without retyping the commands.

## 0.0.1

- Show the version in the sidebar.
- Put Tasks next to Library and Settings, and on the narrow-screen header.
