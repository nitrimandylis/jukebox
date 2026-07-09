# music-cli

A single-file Bun CLI that plays my Apple Music library from the terminal by
remote-controlling Music.app over AppleScript/JXA. Sibling in spirit to
[jazz](https://github.com/nitrimandylis/jazz) (same author-style: one file,
zero runtime deps, compiled with `bun build --compile`).

register: product (a tool — design serves the product)

## What it is

- **The TUI is the main way in**: bare `music` opens a two-panel app,
  lazygit-style. Left: a browser with songs / albums / playlists tabs — the
  whole library is bulk-fetched once at startup (~0.2s for ~1700 tracks) and
  filtered locally with `/`, newest additions first. Enter plays; `l` drills
  into an album/playlist and enter inside plays it from that track. Right:
  the now-playing panel — album art as real pixels (Kitty graphics), progress
  bar tinted with the cover's dominant color, shuffle/repeat/volume status.
  Transport keys are global: space pause, n/p skip, +/- volume, s/r modes.
- **Quick commands are the extras**: `music play <query>` (fzf-pick a song),
  `music album` / `music playlist` (pick and play whole), `music pause|next|prev`,
  `music shuffle|repeat`, `music search <query>`.

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
