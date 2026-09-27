# Changes

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
