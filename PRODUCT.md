# jukebox

A single-file Bun CLI that plays my Apple Music library from the terminal by
remote-controlling Music.app over AppleScript/JXA. Sibling in spirit to
[jazz](https://github.com/nitrimandylis/jazz) (same author-style: one file,
zero runtime deps, compiled with `bun build --compile`).

register: product (a tool — design serves the product)

## What it is

- **The TUI is the main way in**: bare `juke` opens a three-panel app,
  lazygit-style, in equal-width columns (stacking vertically on narrow
  terminals). Left: the now-playing panel — album art as real pixels (Kitty
  graphics), progress bar tinted with the cover's dominant color. Middle
  (⇥ cycles): a preview panel showing the track list behind the browse
  cursor, lyrics, or the queue — the queue view has its own cursor (j/k,
  enter plays, x removes, J/K reorder). Right: the browser with
  songs / albums / playlists / artists tabs (1/2/3/4) — the whole library is
  bulk-fetched once at startup (~0.2s for ~1700 tracks) and filtered locally
  with `/`, newest additions first. Enter plays; `l` drills into an
  album/playlist/artist and enter inside plays it from that track; `a` adds
  the hovered thing to the queue.
  The player also shows a dim details line (genre · year · plays · ♥) and an
  "up next" section fed by the current play context, refreshed only when the
  context changes. Lyrics come from lrclib.net (keyless, time-synced when
  available — the current line highlights and auto-scrolls; cached per track,
  fetched only while the view is open). Status items (shuffle/repeat/volume)
  appear only when non-default, flashing briefly after their key. Transport
  keys are global: space pause, ←/→ skip, +/- volume, s/r modes.
- **Quick commands are the extras**: `juke play <query>` (fzf-pick a song),
  `juke queue <query>` (fzf multi-select songs to play next; bare `queue`
  shows what's coming), `juke album` / `juke artist` / `juke playlist`
  (pick and play whole), `juke pause|next|prev`, `juke shuffle|repeat`,
  `juke search`.
- Artwork and lyrics cache to `~/.cache/jukebox` (persists across reboots).

## Design stance

Terminal-native: default ANSI foreground + dim/bold for all chrome, one
art-derived accent on the progress bar only. No TUI framework, raw escape
codes. The album art is the only full-color element on screen.

## Constraints (accepted)

- macOS only; drives Music.app (launches it if closed).
- Library-only search — no Apple Music catalog (needs a paid developer token).
- Music.app's real Up Next is not scriptable, so the queue is our own
  `jukebox` scratch playlist (albums play through it too). Queueing while
  playing from another context jumps into the scratch playlist at the same
  position — near-seamless, but the old context's upcoming tracks are left
  behind, and shuffle-on ignores queue order.
