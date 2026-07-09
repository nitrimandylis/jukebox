# music-cli

A single-file Bun CLI that plays my Apple Music library from the terminal by
remote-controlling Music.app over AppleScript/JXA. Sibling in spirit to
[jazz](https://github.com/nitrimandylis/jazz) (same author-style: one file,
zero runtime deps, compiled with `bun build --compile`).

register: product (a tool — design serves the product)

## What it is

- **Quick commands**: `music play <query>` (fzf-pick a song), `music album` /
  `music playlist` (pick and play whole), `music pause|next|prev`,
  `music shuffle|repeat`, `music search <query>`.
- **Live player**: bare `music` opens a vertical now-playing view — album art
  rendered as real pixels (Kitty graphics protocol, Ghostty), title/artist,
  ticking progress bar tinted with the album art's dominant color, a dim
  status line (shuffle/repeat/volume), and a keybind hint footer that fades
  after a few seconds. Everything else inherits the terminal's own theme.

## Design stance

Terminal-native: default ANSI foreground + dim/bold for all chrome, one
art-derived accent on the progress bar only. No TUI framework, raw escape
codes. The album art is the only full-color element on screen.

## Constraints (accepted)

- macOS only; drives Music.app (launches it if closed).
- Library-only search — no Apple Music catalog (needs a paid developer token).
- No Up Next manipulation (AppleScript barely exposes it). Albums play via a
  throwaway `music-cli` playlist.

## Where it's headed (maybe)

- Artist as a first-class play target.
- `music love` / `music add <playlist>` for triaging new music.
- Catalog search if a MusicKit token ever materializes.
