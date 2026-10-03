# jukebox

A single-file Bun CLI that plays my Apple Music library from the terminal by
remote-controlling a real client: Music.app over AppleScript/JXA, or
[Cider](https://cider.sh) over its local HTTP API. Sibling in spirit to
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
  keys are global: space pause, ←/→ skip, +/- volume, s/r modes. `g`/`G` jump
  to the top / bottom of the list.
- **Quick commands are the extras**: `juke play <query>` (fzf-pick a song),
  `juke queue <query>` (fzf multi-select songs to play next; bare `queue`
  shows what's coming), `juke album` / `juke artist` / `juke playlist`
  (pick and play whole), `juke pause|next|prev`, `juke shuffle|repeat`,
  `juke search`, `juke status` (what is playing, no TUI).
- **`--json` is the machine interface**, on `status`, `search` and bare
  `queue`. One JSON value on stdout, errors on stderr with a non-zero exit.
  `status` exists because reading what is playing previously meant driving
  Music.app or Cider yourself.
- Artwork and lyrics cache to `~/.cache/jukebox` (persists across reboots).

## Backends

Everything above is one `Player` interface with two implementations, chosen
at startup. Music.app is the default and the fallback. Cider 4 is used when
`JUKEBOX_CIDER_TOKEN` is set *and* its local API (127.0.0.1:10767) answers a
200; `JUKEBOX_PLAYER=cider|music` overrides. With no token nothing is probed,
so Music.app users pay no startup latency; `JUKEBOX_PLAYER=cider` that can't
connect is a hard error rather than a silent downgrade.

Cider is a full peer, not a speaker: library, search, playback, queue, art
and lyrics all come from it. It differs from Music.app in four places —
its own queue replaces the queue file and the watcher entirely, the library
arrives over paged HTTP (~3s measured for 1891 songs, so the browser fills in after the player
panel is already live), lyrics are Apple's own TTML instead of lrclib, and
there is no play count. `r` cycles none→one→all there (Cider exposes only a
toggle) against Music's off→all→one, and `juke search` returns at most 25
hits against Music's 100 — the library search endpoint caps there, and asking
for more returns an empty result rather than a truncated one. `juke album`
and `juke artist` therefore never go through search for their track lists:
the album resolves to a real album id, and the artist reuses the browser's
own grouping over the full library.

**Cider's queue is eventually consistent, and that is the landmine.** A write
(`add-later`, `remove-by-index`) returns 200 roughly 500-870ms before either
`/v1/playback/queue` or `/v2/queue/position` reflects it. Three consequences,
each learned the expensive way:

1. **Never confirm a write by reading the queue back.** The read says nothing
   landed, and re-adding on that evidence queues every song twice. Where
   `add-later` genuinely needs a session to exist, poll `now-playing` until
   `play-item`'s track is really current instead of counting.
2. **Never space the adds less than ~100ms apart.** Fired back to back they
   arrive out of order (five tracks came back t1 t2 t5 t3 t4), which is how
   "play this album" turns into shuffle. 50ms still scrambles, 100ms is
   clean; `ADD_GAP_MS` is 150 for margin. An `id` array is a 400, so there is
   no bulk call to escape into. A long list fills in behind the first track
   (~15s for 101 tracks) rather than all at once, and a new play cancels an
   in-flight fill.
3. **Never send an index-based op from a read more than a second old.** The
   queue shifts underneath, and any `play-item` (from us, from you, from
   Cider's own UI) replaces the whole queue with a single track.

## Design stance

Terminal-native: default ANSI foreground + dim/bold for all chrome, one
art-derived accent on the progress bar only. No TUI framework, raw escape
codes. The album art is the only full-color element on screen.

## Constraints (accepted)

- macOS only; drives Music.app (launches it if closed) or Cider.
- Library-only search — no Apple Music catalog. Cider could serve one (its
  API proxies the real Apple Music API on the user's own subscription), but
  catalog search is the one non-parity feature and gets its own design pass.
- **On Music.app:** its real Up Next is not scriptable, so the queue is our
  own: a JSON file (`~/.cache/jukebox/queue.json`) plus a detached watcher
  process that plays the next track just before the current one ends (albums
  and artists play through it too; real playlists play natively). No playlist
  clutter in Music.app anymore — the trade is no gapless playback across
  queued tracks, and Music's shuffle/repeat don't apply to the file queue.
  None of this exists on Cider, which has a real queue.
- `juke queue` with no argument lists the current track and what follows,
  not the tracks already played: only the Music backend remembers those.
