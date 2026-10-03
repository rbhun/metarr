# Changes

## 0.0.160

- Cap how long ffmpeg holds a rewrap in memory. With no cap, a sparse Blu-ray subtitle kept a 50 GB M2TS in RAM until the process was killed, which showed up as "ffmpeg exited with code null."

## 0.0.159

- Beta version merge: find titles with two similar-length copies that carry different audio, compare frames, and manually combine them into one MKV that keeps the better video plus every audio and subtitle track. The demo library includes Blade Runner 2049 as a sample pair.

## 0.0.158

- Read this process's cgroup for container CPU so the figure is this container, not the whole machine.

## 0.0.157

- Show this container's CPU next to the whole-machine figure, so a rip's load is distinct from Plex or the rest of the VM.

## 0.0.156

- Put CPU use on the version row, right-aligned, in the sidebar and the phone menu.

## 0.0.155

- Show CPU use in the top of the sidebar and the phone menu, so load from a rip or language check is visible without opening a shell.

## 0.0.154

- Show how many titles match the current library filter next to the totals.

## 0.0.153

- Read MakeMKV's whole title list. Metarr kept only the last 200 KB of MakeMKV's output, so on discs with a hundred titles the first titles, usually the film's playlists, were cut off before parsing; Fight Club showed 20 of 107 titles and ripped a clip. The MakeMKV log page now shows up to 8 MB per section.

## 0.0.152

- The MakeMKV log starts with a disc summary: the largest MakeMKV titles with the clips they play, and the largest stream files in the Blu-ray folder. One unreadable stream file no longer switches off the check that stops a rip when MakeMKV skips the main film.

## 0.0.151

- Add Do not wait for Plex in Settings, so language checks, disc remux, and rewrap keep going while Plex is scanning or someone is playing.

## 0.0.150

- Do not rip a Blu-ray folder when MakeMKV offers no title that could hold the disc's largest stream file. On Fight Club MakeMKV never listed the 32 GB feature, so Metarr saved a 288 MB clip; now the task fails and names the missing file.

## 0.0.149

- Rename a file whose name is a secondary-language episode title to Show - S01E07 - English title, so Sonarr can import it and search for the episodes that are still missing.

## 0.0.148

- Rip the largest Blu-ray title instead of the longest. On discs with hundreds of clips one clip can report a broken, hours-long duration, so a 181 MB clip was saved as the movie. A rip far smaller than MakeMKV announced now fails instead of being saved, and the result names the playlist, length and size.

## 0.0.147

- Match a file’s local-language title to the episode list, and show that episode’s English name and Sonarr number.

## 0.0.146

- Look up every title from one button, so a refresh does not depend on selecting each row.

## 0.0.145

- Add Rescan files on a title’s detail panel so one movie or episode can re-read its folder on disk and the connected apps without a full library sync.

## 0.0.144

- Fix the image build: TypeScript rejected a part-number match that could be null, so `npm run build` failed in Docker.

## 0.0.143

- Add Cancel sync on the sync window so a long library sync can be stopped without closing the app.

## 0.0.142

- Show the secondary title under the library name. TMDB is asked in the chosen language, because the translation list often has no name.

## 0.0.141

- Show each episode’s title in the secondary language. The names come from TMDB when the series is looked up.

## 0.0.140

- Keep a spoken language only when the sample points agree, so one clip cannot label a Hungarian episode as English or Japanese.

## 0.0.139

- An episode path such as Season 1/07 is no longer labeled as part 1 of 7.

## 0.0.138

- Keep the disk read for multi-part rewrap on the server, so the title page no longer pulls node:fs into the browser bundle and the image build can finish.

## 0.0.137

- Show in Settings when main has a newer Metarr version, so an update is visible before it is installed.

## 0.0.136

- Treat a three-part movie the same as a two-part one: the Versions filter is Multi-part, and a rewrap joins all of the labeled parts.

## 0.0.135

- Join a labeled split movie, such as CD1 and CD2 or 1 of 2, into one MKV when rewrapping. Those movies have their own Two-part filter and no longer show up as duplicates.

## 0.0.134

- Describe the library, language detection, disc remux, and rewrap features in one place.

## 0.0.133

- Filter the library by movie or series, and by length in minutes.

## 0.0.132

- Read a binary `.sub` subtitle as pictures, so its language can be recognized instead of being rejected as unreadable text.

## 0.0.131

- Add Push to Plex on the selected rows, so those folders are scanned again.

## 0.0.130

- Extras, featurettes, outtakes, comic relief, and trailers are labeled on each version row from the file or folder name (including common subfolders like Featurettes and Outtakes). Bonus copies do not count as Duplicate versions. The Versions filter can also pick Extra, Outtake, Comic Relief, or Trailer. The demo Godfather title includes a featurette and outtakes.

## 0.0.129

- The library Filters menu has a Versions filter: None (a single unlabeled copy), Duplicate (multiple copies with no edition label), or a specific edition such as Theatrical or Director's Cut. The demo Matrix title has two unlabeled copies so Duplicate is easy to try.

## 0.0.128

- Separate audio files beside a video (or in an `audio` subfolder), such as `.ac3`, are found and listed even though Plex ignores them. They show as external rows marked "not in Plex", with the language from the file name when it is tagged. The demo Godfather title includes a Hungarian `.ac3` example.

## 0.0.127

- Special releases marked in the file name (extended, theatrical, restored, directors, anniversary) show a label on each version row in the library, so different cuts of the same title are easy to tell apart. The demo library includes Kingdom of Heaven with theatrical and director’s cuts so the labels are easy to spot.

## 0.0.126

- Sample a short audio track near the start as well as the middle, so a cut-off extra can still be heard.

## 0.0.125

- Loose M2TS and TS files, which cannot store a track language, can now be rewrapped into an MKV beside them, like AVIs. The MKV gets the audio and subtitle languages Metarr recognized, PGS subtitles are kept, and Blu-ray PCM audio is stored as lossless FLAC because Matroska cannot hold it as it is. A rewrap uses the latest languages when it starts, not only the ones known when it was queued. When a language cannot be written into one of these files, the message now points to Rewrap to MKV.

## 0.0.124

- The folder scan now reads the subtitle files beside each video and compares them with what Plex lists, instead of checking only when a page opens. Files Plex does not list show with "Plex: missing" in the tooltip and a note saying why. When Plex would read the file by its name, Metarr asks Plex to refresh that title after the scan, at most once a week per file. When the name keeps Plex from reading it, the note gives the name Plex expects.

## 0.0.123

- Subtitle files in a video's folder that Plex does not list now show as their own rows marked "not in Plex", with the language from the file name, and unnamed ones can be language-checked. Folder listings refresh after a minute instead of staying cached until a restart, so renamed or deleted subtitles show up correctly. A subtitle for "Film Extended" in the same folder is no longer matched to "Film".

## 0.0.122

- Compare Plex's external subtitles with the file check. A subtitle Plex lists with no file beside the video now says "Plex only", and its hover shows File scan: missing with the likely reason (Plex downloaded it into its own data folder). A sidecar found on disk shows File scan: present.

## 0.0.121

- Redo on a failed task that is already queued now removes the old failure from the list (and runs the queued language check now), instead of only saying it is already queued. Redo all also drops failures that already have a queued copy and keeps one retry per track.

## 0.0.120

- Fix the Docker build after 0.0.117: the subtitle name check that the library page uses pulled server-only file code into the browser bundle.

## 0.0.119

- Read picture subtitles (PGS) on Blu-ray `.m2ts` files from byte slices instead of a timestamp seek, which read the disc from the start and could time out. One slow sample no longer stops the others, and a full timeout says the share was slow and Redo tries again.

## 0.0.118

- Do not queue language checks for a Plex external subtitle with no file path (that was trying to read the video as text). Match sidecars by title stem when the video uses a different base name, such as `refined-21.mkv` beside `refined-21.en.srt`.

## 0.0.117

- Drop stale Plex subtitle paths that are gone from disk, rematch them to language-tagged sidecars in the folder, and skip language checks when the file name already has a language (for example `.hun.srt` / `.en.hi.srt`).

## 0.0.116

- When an external subtitle path fails to open, say whether it is missing, permission-denied, or a name mismatch, and try a same-folder sidecar whose title matches after dropping language tags and year brackets.

## 0.0.115

- Run overnight language checks before writing earlier results into files. A backlog of tag writes was clearing the pause reason so Tasks said Queued while nothing was ever claimed.

## 0.0.114

- Fix the Docker build after the language waiting reason: pass the database into writeDetectPause.

## 0.0.113

- Language checks in Tasks now say why they are waiting (outside the window, Plex busy, a remux running, or switched off), instead of always showing "Waiting for the window". Check Settings → Schedules → Clock: the container used UTC, so a 01–06 window stayed closed until 03:00 local time.

## 0.0.112

- A DVD whose listed file is gone (VIDEO_TS.VOB is optional) now converts from its VIDEO_TS folder. When a disc really cannot be opened, the task says which part of the path is missing or refused, and the MakeMKV log page says MakeMKV never ran for that job.

## 0.0.111

- Show why a waiting disc remux or AVI rewrap has not started (Plex busy, language detection running, outside the window, or switched off) in Tasks instead of "Starting", and say so on Rips when disc remux is switched off.

## 0.0.110

- Check the MakeMKV program's own version when deploying. 0.0.107 relabelled the saved 2.0.0 copy as 1.18.4 instead of building 1.18.4, so Blu-rays kept crashing.
- Redo all brings back each failed rip once, from its latest failure, and skips discs that are already converted. A disc converted before counts as done, not failed.
- Settings → Schedules shows the server clock and time zone, and lets you pick the time zone. The container ran on UTC, so the windows were two hours off.

## 0.0.109

- Put All / Movies / Series on the same row as Filters and Add filter so the library toolbar uses one line on a phone.

## 0.0.108

- Clear the library top bar: move Fill missing metadata to Settings, drop the duplicate Clear library button, and tuck quick filters behind a toggle so the phone layout stays usable.

## 0.0.107

- Install MakeMKV 1.18.4 instead of 2.0.0. MakeMKV 2.0.0 crashes (SIGSEGV) on every unencrypted Blu-ray image or folder, key or not, while 1.18.4 reads them with the same beta key. Deploy now rebuilds MakeMKV when the saved copy is another version.

## 0.0.106

- Copy MakeMKV's own debug log into the job's MakeMKV log. MakeMKV ignores the log path it is given and writes the file to its home folder instead, so the log link showed only MakeMKV's printed output.

## 0.0.105

- Save MakeMKV's output and debug log for each disc job and link it from Tasks as "MakeMKV log", so a crash can be diagnosed without the server console.

## 0.0.104

- Install mmccextr, the MakeMKV helper that was left out of the saved MakeMKV copy, and point a MakeMKV crash at the key first, since a missing or expired key is the usual cause on Blu-ray.

## 0.0.103

- Install MakeMKV's data files (the default profile and Blu-ray data in appdata.tar) with the binaries, and say which signal stopped MakeMKV instead of "stopped without an exit code".

## 0.0.102

- Add Redo all on the Failed list in Tasks, so hundreds of failed language checks can go back on the overnight queue without clicking each one. Clearing failed jobs still only hides them.

## 0.0.101

- Add Settings → Update Metarr: the button asks a small systemd helper on the host to run deploy.sh, and shows its progress and log, so updates no longer need the console. deploy.sh installs the helper the next time it runs.

## 0.0.100

- Copy a PGS track out of an MKV in one pass, and keep trying a Blu-ray audio slice after a slow read, so idle overnight checks do not miss the same samples again.

## 0.0.99

- Rewrap AVI files into MKV with ffmpeg, without re-encoding, so seeking works and audio languages can be stored. AVIs get their own list in Rips (to rewrap and already rewrapped), their own hours and settings, a Rewraps tab in Tasks, and a Rewrap to MKV button in the library.

## 0.0.98

- Add a Convert button to the library panel for disc titles; it remuxes right away instead of waiting for the overnight window.

## 0.0.97

- Show the real reason a MakeMKV remux failed instead of its routine ISO status lines, and point to the MakeMKV key when Blu-ray needs one.

## 0.0.96

- Write a recognized language into the file when a folder scan finds that track unlabeled.

## 0.0.95

- Show an audio-format mismatch in indigo, so it stays separate from the amber used when a language was left out.

## 0.0.94

- Use the SQLite build shipped with the package, so deploy does not download Node headers from nodejs.org.

## 0.0.93

- Leave the npm install in place across deploys. A version bump was changing package.json, so every deploy downloaded the packages again and the install could fail.

## 0.0.92

- Read the audio format and channel count from the file when a track is missing them, and ask Plex, Radarr, and Sonarr to re-read that file. A mismatch is shown on the language name.

## 0.0.91

- Click the No Plex pill to ask Plex to scan that title’s folder, so a new file can be recognized.

## 0.0.90

- Check a recognized language against the file, and write it when the track is still unlabeled.

## 0.0.89

- Install MakeMKV during deploy only when it is missing, and re-read just the file that received a language from each source.

## 0.0.88

- Click a title under Already converted on Rips, or on Tasks, to open it in the library.

## 0.0.87

- Move a disc that already has a converted file to an "Already converted" list on Rips, so the disc list only shows what still needs a remux.

## 0.0.86

- Read the language Radarr stores on the movie file when its audio field is blank, so that label is not treated as missing.

## 0.0.85

- Say on a language label when Metarr recognized it, and name Radarr or Sonarr there when the title is in that app.

## 0.0.84

- If a finished language file cannot be renamed into its folder, copy it in, and name the folder when that write is refused.

## 0.0.83

- Say Radarr or Sonarr is missing on a track when that app has the file and stored no audio language.

## 0.0.82

- When mkvpropedit cannot open an MKV, copy the streams back into that same file with the language set, and keep mkvpropedit's own reason if that also fails.

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
