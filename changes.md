# Changes

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
