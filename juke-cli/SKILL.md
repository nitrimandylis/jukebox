---
name: juke-cli
description: Drive the juke CLI (jukebox) — control Apple Music playback from the terminal through Music.app or Cider. Use whenever the user wants to play, pause, skip, queue, shuffle or search music, asks what is playing, mentions jukebox, juke, Cider, or Apple Music, or wants a song/album/artist/playlist started without leaving the terminal.
---

# juke

`juke` is a remote control for Apple Music. Music.app (or Cider) does the playing; juke points at it.
Compiled Bun binary at `~/.bun/bin/juke`. Full offline reference: `man juke`.

Backend choice is automatic: with `JUKEBOX_CIDER_TOKEN` set, juke uses Cider when Cider is running and
Music.app when it isn't. `JUKEBOX_PLAYER=cider|music` pins it by hand.

## What you can run headlessly

These take no input and print or act immediately. Safe to run for the user:

```bash
juke status            # what is playing right now
juke search <query>    # list matching songs, plays nothing
juke pause             # toggle play/pause
juke next              # skip forward
juke prev              # skip back
juke shuffle           # toggle shuffle
juke repeat            # cycle repeat
juke queue             # show the current queue (no query = show, don't add)
juke play              # with no query: resume playback
juke help              # usage, same as --help
```

With `--json`, for parsing rather than printing:

```bash
juke status --json     # {backend, state, track, volume, shuffle, repeat} — track is null when idle
juke search <q> --json # [{id, name, artist, album}]
juke queue --json      # {playing, up, approximate}; up is [{id, name, artist}]
```

`juke search` is the right tool when the user asks "is X in my library". It never starts anything.
`juke status` is the one for "what's playing" — do not open the TUI to find out, and do not drive
Music.app or Cider yourself.

## What needs a human at the keyboard

**`juke` with no arguments opens a full-screen TUI, and `juke play|queue|album|artist|playlist <query>`
opens an fzf picker.** Neither can be driven from a tool call: there is no terminal to draw on and no
one to press enter. Do not spawn them and hope.

When the user asks for something specific to play, give them the command to run:

```bash
juke album "the color and the shape"
juke play "not like us"
juke queue "modern jazz"      # or: juke play -q "modern jazz" (--queue is the long form of -q)
```

If they want it started without a picker, use `juke search <query>` first to confirm the track exists and
show them the match, then hand over the command. Guessing at a fuzzy match and firing a picker they
cannot see is worse than one extra round trip.

## Things that will bite you

- **In `juke status --json`, test `track`, not `state`.** A stopped player still reports a volume and
  a repeat mode, so the object is never empty; `track: null` is what "nothing is loaded" looks like.
- **`approximate: true` in the queue JSON means the order is a guess.** Shuffle reshapes the backend's
  own context and the list cannot be read back exactly. Do not present it to the user as the next
  tracks in order when that flag is set.

- **The queue is jukebox's own, on Music.app.** Apple never exposed Up Next to scripting, so juke keeps
  `~/.cache/jukebox/queue.json` plus a detached watcher process (`juke watch`, spawned for you) that
  starts the next track just before the current one ends. On Cider the queue is real and both sit out.
  So on Music.app: the queue survives juke exiting, but taking manual control in Music.app ends the
  watcher. A queue that "stopped working" is usually that.
- **Music.app control needs a macOS automation permission** granted to the terminal, once, on first run.
  If commands return nothing and no error, that permission is the first thing to check — the failure is
  silent.
- **Album art needs a Kitty-graphics terminal** (Ghostty, kitty, WezTerm). Only relevant to the TUI,
  which you are not running anyway.
- **Cider's startup is slower than Music.app's.** Music hands over the whole library in one bulk fetch
  (~0.2s for ~1700 tracks); Cider needs ~3s of paged HTTP. On Cider the browser says `loading library…`
  for a moment. That is not a hang.
- **Never read or print `JUKEBOX_CIDER_TOKEN`.** It is a credential. juke reads it from the environment
  itself. If it is missing, say so and let the user mint one in Cider → Settings → Connectivity →
  External Application API.
- **Lyrics on Music.app go to lrclib.net**, sending title, artist and duration when the lyrics view is
  open. Worth mentioning if the user cares about what leaves the machine; nothing else does.
