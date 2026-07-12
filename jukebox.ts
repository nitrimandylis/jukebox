#!/usr/bin/env bun
// juke — Apple Music for the terminal (the jukebox project).
// Music.app does the playing (its library is DRM'd, so nothing else can);
// this CLI is the remote control and the pretty face. Data flows over
// osascript: JXA for queries, AppleScript for the artwork dump. Album art
// renders as real pixels via the Kitty graphics protocol (Ghostty, kitty,
// WezTerm); everything else inherits the terminal's own theme.
//
// Usage: juke                      the TUI (browser + player) — the main way
//        juke play [query]         pick a song and play it (no query: resume)
//        juke queue [query]        pick songs to play next (no query: show queue)
//        juke play -q <query>      same as juke queue
//        juke album <query>        pick an album, play it in order
//        juke artist <query>       pick an artist, play everything by them
//        juke playlist <query>     pick a playlist, play it
//        juke search <query>       list matches without playing
//        juke pause | next | prev  transport
//        juke shuffle | repeat     toggle / cycle
//
// TUI keys: j/k move · 1/2/3 switch tabs · ⇥ preview/lyrics · / filter
//           enter play · a add to queue · l open album/playlist · h back
//           ␣ pause · ←/→ prev/next · +/- volume · s/r shuffle/repeat · q quit

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";

const CACHE = `${homedir()}/.cache/jukebox`; // artwork + lyrics cache, queue file
const TEMP_PLAYLIST = "jukebox"; // legacy scratch playlist — the watcher deletes it on sight

// ---------------------------------------------------------------------------
// Talking to Music.app

// Set by the TUI so a fatal error restores the terminal before exiting.
let onFatal: (() => void) | null = null;

function osascript(args: string[]): string {
  const res = Bun.spawnSync(["osascript", ...args], { stderr: "pipe" });
  if (res.exitCode !== 0) {
    const err = res.stderr.toString().trim();
    onFatal?.();
    console.error(`Music.app said no: ${err}`);
    process.exit(1);
  }
  return res.stdout.toString().trim();
}

// Run a JXA snippet with `music` in scope; the snippet returns a JSON string.
function jxa(body: string): any {
  const script = `(function () { const music = Application("Music"); ${body} })()`;
  const out = osascript(["-l", "JavaScript", "-e", script]);
  return out ? JSON.parse(out) : null;
}

// Like jxa, but returns null on error instead of exiting — the watcher runs
// unattended and must shrug off Music.app's transient errors.
function jxaQuiet(body: string): any {
  const script = `(function () { const music = Application("Music"); ${body} })()`;
  const res = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", script], { stderr: "pipe" });
  if (res.exitCode !== 0) return null;
  const out = res.stdout.toString().trim();
  return out ? JSON.parse(out) : null;
}

export type Track = {
  id: string; name: string; artist: string; album: string;
  albumArtist: string; disc: number; track: number; added: number;
};

// persistentID → database id, filled by loadLibrary/searchLibrary. Stored
// into the queue file so playback resolves tracks with direct byId()
// lookups instead of a whose() scan.
let dbidMap: Record<string, number> = {};

// Track/Song → what the queue file stores.
function qt(t: { id: string; name: string; artist: string }): QueueTrack {
  return { id: t.id, db: dbidMap[t.id], name: t.name, artist: t.artist };
}

// One bulk fetch per property: the whole library arrives in well under a
// second, so the TUI never talks to Music.app while you type.
function loadLibrary(): Track[] {
  const rows = jxa(`
    const tr = music.libraryPlaylists[0].tracks;
    const names = tr.name(), artists = tr.artist(), albums = tr.album(),
      albumArtists = tr.albumArtist(), ids = tr.persistentID(),
      discs = tr.discNumber(), nums = tr.trackNumber(), added = tr.dateAdded(),
      dbids = tr.id();
    return JSON.stringify(names.map((n, i) => [ids[i], n, artists[i], albums[i],
      albumArtists[i], discs[i], nums[i], added[i], dbids[i]]));
  `);
  return rows.map((r: any[]) => {
    dbidMap[r[0]] = r[8];
    return {
      id: r[0], name: r[1] || "", artist: r[2] || "", album: r[3] || "",
      albumArtist: r[4] || "", disc: r[5] || 0, track: r[6] || 0,
      added: r[7] ? Date.parse(r[7]) : 0,
    };
  });
}

function loadPlaylistNames(): string[] {
  return jxa(`return JSON.stringify(music.userPlaylists.name());`)
    .filter((n: string) => n !== TEMP_PLAYLIST);
}

function loadPlaylistTracks(name: string): Track[] {
  const rows = jxa(`
    const tr = music.playlists.byName(${JSON.stringify(name)}).tracks;
    const names = tr.name(), artists = tr.artist(), albums = tr.album(), ids = tr.persistentID();
    return JSON.stringify(names.map((n, i) => [ids[i], n, artists[i], albums[i]]));
  `);
  return rows.map((r: any[]) => ({
    id: r[0], name: r[1] || "", artist: r[2] || "", album: r[3] || "",
    albumArtist: "", disc: 0, track: 0, added: 0,
  }));
}

type Song = { id: string; name: string; artist: string; album: string };

// Search every visible field (name, artist, album) of the library.
// ponytail: capped at 100 hits — each mapped property is one Apple Event.
function searchLibrary(query: string): Song[] {
  return jxa(`
    const hits = music.search(music.libraryPlaylists[0], { for: ${JSON.stringify(query)} });
    const out = [];
    for (const t of hits.slice(0, 100)) {
      // search can return dead references (tracks removed from the cloud
      // library); touching any property of one throws -1728. Skip them.
      try { out.push({ id: t.persistentID(), name: t.name(), artist: t.artist(), album: t.album(), db: t.id() }); }
      catch (e) {}
    }
    return JSON.stringify(out);
  `).map((s: any) => {
    dbidMap[s.id] = s.db;
    return { id: s.id, name: s.name, artist: s.artist, album: s.album };
  });
}

// ---------------------------------------------------------------------------
// The queue: a JSON file, not a Music.app playlist. Music only auto-advances
// inside a playlist context, and a scratch playlist syncs to every device
// via iCloud — clutter. So the queue lives in queue.json and a detached
// watcher process (hidden `juke watch` command) plays the next track when
// the current one ends. Real user playlists still play natively.
// ponytail: no gapless playback across queued tracks — the watcher preempts
// just before a track ends.

export type QueueTrack = { id: string; db?: number; name: string; artist: string };
// tracks[pos] is playing; pos -1 means the queue waits behind a foreign
// track (something we didn't start) and begins when it ends.
export type Queue = { tracks: QueueTrack[]; pos: number };

const QUEUE_FILE = `${CACHE}/queue.json`;
const PID_FILE = `${CACHE}/watcher.pid`;

function readQueue(): Queue | null {
  try {
    const q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    if (Array.isArray(q.tracks) && q.tracks.length > 0) return q;
  } catch (e) {} // no queue
  return null;
}

function writeQueue(q: Queue | null) {
  if (!q || q.tracks.length === 0) {
    try { unlinkSync(QUEUE_FILE); } catch (e) {}
    return;
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(q));
}

// Pure queue edits (tested in jukebox.test.ts). `i` indexes into upNext(q):
// the upcoming list starts at tracks[pos + 1] — or tracks[0] when pos is -1.
export function upNext(q: Queue): QueueTrack[] {
  return q.tracks.slice(q.pos + 1);
}

export function removeUpcoming(q: Queue, i: number): Queue {
  const tracks = [...q.tracks];
  tracks.splice(q.pos + 1 + i, 1);
  return { tracks, pos: q.pos };
}

export function moveUpcoming(q: Queue, i: number, d: number): Queue | null {
  const j = i + d;
  const len = upNext(q).length;
  if (i < 0 || i >= len || j < 0 || j >= len) return null;
  const tracks = [...q.tracks];
  const a = q.pos + 1 + i, b = q.pos + 1 + j;
  [tracks[a], tracks[b]] = [tracks[b], tracks[a]];
  return { tracks, pos: q.pos };
}

// Play one track directly — no playlist, no context. Music never adopts a
// context from this, which is exactly what we want: the watcher decides
// what plays next. Cold-started Music swallows the first play; retry once.
function playSnippet(t: QueueTrack): string {
  return `
    const lib = music.libraryPlaylists[0];
    let tr = null;
    ${t.db ? `try { tr = lib.tracks.byId(${t.db}); tr.name(); } catch (e) { tr = null; }` : ""}
    if (!tr) { try { const f = lib.tracks.whose({ persistentID: ${JSON.stringify(t.id)} }); tr = f.length ? f[0] : null; } catch (e) {} }
    if (tr) {
      try { music.play(tr); } catch (e) {}
      delay(0.3);
      if (music.playerState() !== "playing") { try { music.play(tr); } catch (e) {} }
    }
  `;
}

function playTrack(t: QueueTrack, quiet = false) {
  (quiet ? jxaQuiet : jxa)(playSnippet(t) + `return "";`);
}

// Spawn the watcher if one isn't already running. Detached, so the queue
// keeps playing after the terminal closes.
function ensureWatcher() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8"));
    if (pid > 0) { process.kill(pid, 0); return; } // alive
  } catch (e) {} // no pidfile or dead pid
  // compiled binary: re-exec ourselves; dev run: bun + this file
  const cmd = import.meta.path.startsWith("/$bunfs")
    ? [process.execPath, "watch"]
    : [process.execPath, import.meta.path, "watch"];
  const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(PID_FILE, String(child.pid));
  child.unref();
}

// Fresh play: overwrite the queue and start at startId (or the top). The
// whole list is kept, pos mid-list, so prev can walk backwards.
function playTracks(tracks: QueueTrack[], startId?: string) {
  const pos = startId ? Math.max(0, tracks.findIndex((t) => t.id === startId)) : 0;
  writeQueue({ tracks, pos });
  playTrack(tracks[pos]);
  ensureWatcher();
}

// Queue op: append when Music is playing our queue; otherwise start a new
// queue — behind the current foreign track if one is playing (pos -1),
// immediately if not.
function queueTracks(tracks: QueueTrack[]): "queued" | "started" {
  const q = readQueue();
  const s = jxa(`
    const out = { state: music.playerState(), id: "" };
    try { out.id = music.currentTrack.persistentID(); } catch (e) {}
    return JSON.stringify(out);
  `);
  const active = s.state === "playing" || s.state === "paused";
  if (q && active && (q.pos === -1 || q.tracks[q.pos]?.id === s.id)) {
    writeQueue({ tracks: [...q.tracks, ...tracks], pos: q.pos });
    ensureWatcher();
    return "queued";
  }
  if (active) {
    writeQueue({ tracks, pos: -1 });
    ensureWatcher();
    return "queued";
  }
  writeQueue({ tracks, pos: 0 });
  playTrack(tracks[0]);
  ensureWatcher();
  return "started";
}

// next/prev walk the file queue when one is active; callers fall back to
// Music's own transport (native playlist contexts) when these return false.
function queueNext(): boolean {
  const q = readQueue();
  if (!q || q.pos + 1 >= q.tracks.length) return false;
  writeQueue({ tracks: q.tracks, pos: q.pos + 1 });
  playTrack(q.tracks[q.pos + 1]);
  ensureWatcher();
  return true;
}

function queuePrev(): boolean {
  const q = readQueue();
  if (!q || q.pos <= 0) return false;
  writeQueue({ tracks: q.tracks, pos: q.pos - 1 });
  playTrack(q.tracks[q.pos - 1]);
  ensureWatcher();
  return true;
}

// The watcher: poll Music, advance the queue when the current track ends.
// It preempts just before the natural end — Music with no context either
// stops or drifts into whatever stale context it last had, and we want
// neither. Exits when the queue is done, deleted, or the user takes over.
async function watch() {
  process.on("SIGHUP", () => {}); // outlive the terminal
  writeFileSync(PID_FILE, String(process.pid));
  // migration from the playlist era: delete the leftover scratch playlist
  jxaQuiet(`const old = music.userPlaylists.whose({ name: ${JSON.stringify(TEMP_PLAYLIST)} }); while (old.length > 0) music.delete(old[0]); return "";`);
  let lastRemaining = Infinity; // how close the last-seen track was to its end
  let grace = 0; // consecutive ticks with an unexpected track (stale reads)
  while (true) {
    const q = readQueue();
    if (!q) return;
    const s = jxaQuiet(`
      const out = { state: music.playerState(), id: "", pos: 0, dur: 0 };
      try { out.id = music.currentTrack.persistentID(); out.pos = music.playerPosition() || 0; out.dur = music.currentTrack.duration() || 0; } catch (e) {}
      return JSON.stringify(out);
    `);
    if (!s) { await Bun.sleep(1000); continue; } // transient error: skip the tick
    const playing = s.state === "playing";
    const active = playing || s.state === "paused";
    const expected = q.pos >= 0 ? q.tracks[q.pos] : null;
    const next = q.tracks[q.pos + 1]; // pos -1 → tracks[0]
    const remaining = s.dur > 0 ? s.dur - s.pos : Infinity;
    const advance = (to: number) => {
      writeQueue({ tracks: q.tracks, pos: to });
      playTrack(q.tracks[to], true);
      lastRemaining = Infinity;
      grace = 0;
    };

    if (!active) {
      // stopped: a track we watched run out ended naturally → play on;
      // otherwise the user hit stop → the queue is over.
      if (lastRemaining < 3 && next) { advance(q.pos + 1); continue; }
      writeQueue(null);
      return;
    }
    if (expected && s.id === expected.id) {
      grace = 0;
      lastRemaining = remaining;
      if (playing && remaining <= 0.6) {
        if (next) { advance(q.pos + 1); continue; }
        // end of the queue: stop before Music drifts into a stale context
        await Bun.sleep(Math.max(0, (remaining - 0.15) * 1000));
        jxaQuiet(`music.stop(); return "";`);
        writeQueue(null);
        return;
      }
    } else if (next && s.id === next.id) {
      // our play landed, or the user skipped ahead to exactly this track
      writeQueue({ tracks: q.tracks, pos: q.pos + 1 });
      grace = 0;
      lastRemaining = remaining;
    } else if (q.pos === -1) {
      // waiting out a foreign track; start the queue as it ends
      lastRemaining = remaining;
      if (playing && remaining <= 0.6) { advance(0); continue; }
    } else {
      // unexpected track: right after a natural end it's Music drifting
      // into a stale context → reclaim; after a grace window for stale
      // reads, it's the user playing something else → stand down.
      if (lastRemaining < 3 && next) { advance(q.pos + 1); continue; }
      if (++grace >= 3) { writeQueue(null); return; }
    }
    // tighten the poll near a track's end so the preempt lands cleanly
    await Bun.sleep(playing && remaining < 2.5 ? 200 : 1000);
  }
}

function showQueue() {
  const q = readQueue();
  if (!q) { console.log("queue is empty — juke queue <query>"); return; }
  q.tracks.forEach((t, i) => {
    if (i === q.pos) console.log(`♪ ${t.name}  ${DIM}${t.artist}${RESET}`);
    else if (i < q.pos) console.log(`${DIM}✓ ${t.name}  ${t.artist}${RESET}`);
    else console.log(`  ${t.name}  ${DIM}${t.artist}${RESET}`);
  });
}

// Command-line album play: no cache to hand, so resolve the album in JXA.
function playAlbum(album: string) {
  const rows = jxa(`
    const spec = music.libraryPlaylists[0].tracks.whose({ album: ${JSON.stringify(album)} });
    let names = [], artists = [], ids = [], dbs = [];
    try { names = spec.name(); artists = spec.artist(); ids = spec.persistentID(); dbs = spec.id(); }
    catch (e) { return JSON.stringify([]); } // dead reference in album
    let discs = [], nums = [];
    try { discs = spec.discNumber(); nums = spec.trackNumber(); }
    catch (e) { discs = new Array(ids.length).fill(0); nums = discs; } // keep library order
    const order = discs.map((d, i) => i);
    order.sort((a, b) => (discs[a] - discs[b]) || (nums[a] - nums[b]));
    return JSON.stringify(order.map((i) => ({ id: ids[i], db: dbs[i], name: names[i], artist: artists[i] })));
  `);
  if (rows.length > 0) playTracks(rows);
}

// Real playlists play natively — Music's own context does the advancing.
function playPlaylist(name: string) {
  writeQueue(null); // the playlist context takes over from any file queue
  jxa(`music.playlists.byName(${JSON.stringify(name)}).play(); return "";`);
}

// Command-line artist play: everything by the artist, album by album.
function playArtist(name: string) {
  const rows = jxa(`
    const spec = music.libraryPlaylists[0].tracks.whose({ artist: ${JSON.stringify(name)} });
    let names = [], artists = [], ids = [], dbs = [];
    try { names = spec.name(); artists = spec.artist(); ids = spec.persistentID(); dbs = spec.id(); }
    catch (e) { return JSON.stringify([]); } // dead reference
    let albums = [], discs = [], nums = [];
    try { albums = spec.album(); discs = spec.discNumber(); nums = spec.trackNumber(); }
    catch (e) { albums = new Array(ids.length).fill(""); discs = albums; nums = albums; } // keep library order
    const order = albums.map((a, i) => i);
    order.sort((a, b) => String(albums[a]).localeCompare(String(albums[b])) || (discs[a] - discs[b]) || (nums[a] - nums[b]));
    return JSON.stringify(order.map((i) => ({ id: ids[i], db: dbs[i], name: names[i], artist: artists[i] })));
  `);
  if (rows.length > 0) playTracks(rows);
}

type Now = {
  state: string; vol: number; shuffle: boolean; repeat: string;
  id: string; name: string; artist: string; album: string; duration: number; pos: number;
  genre: string; year: number; plays: number; fav: boolean;
  plName: string; plCount: number; plSpecial: string; // current play context, for "up next"
};

function nowPlaying(): Now {
  return jxa(`
    const out = { state: music.playerState(), vol: music.soundVolume(),
      shuffle: music.shuffleEnabled(), repeat: music.songRepeat(),
      id: "", name: "", artist: "", album: "", duration: 0, pos: 0,
      genre: "", year: 0, plays: 0, fav: false, plName: "", plCount: 0, plSpecial: "" };
    try {
      const t = music.currentTrack;
      out.id = t.persistentID(); out.name = t.name(); out.artist = t.artist();
      out.album = t.album(); out.duration = t.duration();
      out.pos = music.playerPosition() || 0;
      out.genre = t.genre() || ""; out.year = t.year() || 0;
      out.plays = t.playedCount() || 0;
      try { out.fav = t.favorited(); } catch (e) {}
    } catch (e) {} // no current track
    try {
      out.plName = music.currentPlaylist.name();
      out.plCount = music.currentPlaylist.tracks.length;
      out.plSpecial = music.currentPlaylist.specialKind();
    } catch (e) {} // no play context
    return JSON.stringify(out);
  `);
}

// The tracks of whatever Music is currently playing from, in play order.
// Bulk-fetched once per context change (a library-sized context takes ~0.2s).
function contextTracks(): { ids: string[]; names: string[]; artists: string[] } {
  return jxa(`
    try {
      const tr = music.currentPlaylist.tracks;
      return JSON.stringify({ ids: tr.persistentID(), names: tr.name(), artists: tr.artist() });
    } catch (e) { return JSON.stringify({ ids: [], names: [], artists: [] }); }
  `);
}

// ---------------------------------------------------------------------------
// Album art: AppleScript dumps the raw JPEG/PNG, sips (ships with macOS)
// makes a 512px PNG for the terminal and a 1x1 BMP whose single pixel is the
// average color of the whole cover — that's the accent color.

function fetchArt(id: string): { png: string; accent: [number, number, number] } | null {
  const safe = id.replace(/[^A-Za-z0-9]/g, "");
  const png = `${CACHE}/${safe}.png`, bmp = `${CACHE}/${safe}.bmp`, raw = `${CACHE}/${safe}.raw`;
  if (!existsSync(png) || !existsSync(bmp)) {
    mkdirSync(CACHE, { recursive: true });
    const script = `tell application "Music"
      set t to first track of library playlist 1 whose persistent ID is "${safe}"
      if (count of artworks of t) is 0 then return "none"
      set d to raw data of artwork 1 of t
    end tell
    set f to open for access POSIX file "${raw}" with write permission
    set eof f to 0
    write d to f
    close access f
    return "ok"`;
    if (osascript(["-e", script]) !== "ok") return null;
    Bun.spawnSync(["sips", "-s", "format", "png", "-Z", "512", raw, "--out", png]);
    Bun.spawnSync(["sips", "-z", "1", "1", "-s", "format", "bmp", raw, "--out", bmp]);
    if (!existsSync(png) || !existsSync(bmp)) return null;
  }
  return { png, accent: bmpPixel(readFileSync(bmp)) };
}

// A BMP stores its pixel-data offset at byte 10 (little-endian) and pixels as
// BGR. For a 1x1 image the first three bytes there are the whole picture.
export function bmpPixel(buf: Uint8Array): [number, number, number] {
  const off = buf[10] | (buf[11] << 8) | (buf[12] << 16) | (buf[13] << 24);
  return [buf[off + 2], buf[off + 1], buf[off]];
}

// Covers average toward mud; lift the accent until it reads against a dark
// or light theme without ever inventing a new hue.
export function liftAccent([r, g, b]: [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b, 1);
  const factor = max < 150 ? 150 / max : 1;
  return [Math.min(255, Math.round(r * factor)), Math.min(255, Math.round(g * factor)), Math.min(255, Math.round(b * factor))];
}

// Kitty graphics protocol: base64 PNG in 4096-byte chunks, scaled to fit
// c×r terminal cells. One image id, replaced on track change.
function drawArt(png: string, col: number, row: number, cols: number, rows: number) {
  const b64 = readFileSync(png).toString("base64");
  let out = `\x1b_Ga=d,d=A,q=2\x1b\\`; // clear previous image
  out += `\x1b[${row};${col}H`;
  for (let i = 0; i < b64.length; i += 4096) {
    const more = i + 4096 < b64.length ? 1 : 0;
    const ctrl = i === 0 ? `a=T,f=100,q=2,c=${cols},r=${rows},m=${more}` : `m=${more}`;
    out += `\x1b_G${ctrl};${b64.slice(i, i + 4096)}\x1b\\`;
  }
  process.stdout.write(out);
}

// ---------------------------------------------------------------------------
// Lyrics: Music.app never exposes Apple Music's streaming lyrics, so they
// come from lrclib.net (free, keyless, time-synced). Fetched only when the
// lyrics view is open; cached per track next to the artwork.

export type LyricLine = { t: number; text: string };

// "[01:23.45] line" → { t: 83.45, text: "line" }; plain text → t: -1.
export function parseLyrics(synced: string | null, plain: string | null): LyricLine[] {
  if (synced) {
    const lines: LyricLine[] = [];
    for (const raw of synced.split("\n")) {
      const m = raw.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
      if (m) lines.push({ t: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3] });
    }
    if (lines.length > 0) return lines;
  }
  if (plain) return plain.split("\n").map((text) => ({ t: -1, text }));
  return [];
}

async function fetchLyrics(now: Now): Promise<LyricLine[]> {
  const safe = now.id.replace(/[^A-Za-z0-9]/g, "");
  const cache = `${CACHE}/${safe}.lyrics.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  mkdirSync(CACHE, { recursive: true });
  const headers = { "User-Agent": "jukebox (terminal Apple Music player)" };
  let lines: LyricLine[] = [];
  let definitive = true; // only cache real answers, not network failures
  try {
    const params = new URLSearchParams({
      track_name: now.name, artist_name: now.artist,
      album_name: now.album, duration: String(Math.round(now.duration)),
    });
    const res = await fetch(`https://lrclib.net/api/get?${params}`, { headers, signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data: any = await res.json();
      lines = parseLyrics(data.syncedLyrics, data.plainLyrics);
    } else {
      // exact match missed — search and take the closest duration
      const sp = new URLSearchParams({ track_name: now.name, artist_name: now.artist });
      const sr = await fetch(`https://lrclib.net/api/search?${sp}`, { headers, signal: AbortSignal.timeout(10000) });
      if (sr.ok) {
        const all: any[] = await sr.json();
        const best = all.find((r) => Math.abs((r.duration || 0) - now.duration) < 10) || all[0];
        if (best) lines = parseLyrics(best.syncedLyrics, best.plainLyrics);
      }
    }
  } catch (e) { definitive = false; } // offline or lrclib slow: retry next open
  if (definitive) Bun.write(cache, JSON.stringify(lines));
  return lines;
}

// ---------------------------------------------------------------------------
// Pure helpers (tested in jukebox.test.ts)

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// "━━━━━╸────" — filled part gets the accent color, the rest stays dim.
export function progressBar(pos: number, duration: number, width: number, color: string, dim: string, reset: string): string {
  const frac = duration > 0 ? Math.min(1, pos / duration) : 0;
  const filled = Math.min(width - 1, Math.floor(frac * width));
  return color + "━".repeat(filled) + "╸" + reset + dim + "─".repeat(width - filled - 1) + reset;
}

// stdin delivers fast typing and pastes as one chunk; split it back into
// keys, keeping CSI escape sequences (arrows etc.) intact.
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b" && chunk[i + 1] === "[") {
      let j = i + 2;
      while (j < chunk.length && !(chunk[j] >= "@" && chunk[j] <= "~")) j++;
      keys.push(chunk.slice(i, j + 1));
      i = j + 1;
    } else {
      keys.push(chunk[i]);
      i++;
    }
  }
  return keys;
}

// Greedy word-wrap; the renderer clips any single word wider than `width`.
export function wrapText(text: string, width: number): string[] {
  if (!text) return [""];
  const rows: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    if (cur && cur.length + 1 + w.length > width) { rows.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  rows.push(cur);
  return rows;
}

export function matches(t: { name: string; artist: string; album: string }, query: string): boolean {
  const q = query.toLowerCase();
  return t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q);
}

export type AlbumEntry = { name: string; artist: string; added: number; tracks: Track[] };
export type ArtistEntry = { name: string; added: number; tracks: Track[] };

// Group the library by artist: tracks in album/disc/track order, newest first.
export function groupArtists(tracks: Track[]): ArtistEntry[] {
  const byName = new Map<string, ArtistEntry>();
  for (const t of tracks) {
    if (!t.artist) continue;
    let entry = byName.get(t.artist);
    if (!entry) {
      entry = { name: t.artist, added: 0, tracks: [] };
      byName.set(t.artist, entry);
    }
    entry.tracks.push(t);
    entry.added = Math.max(entry.added, t.added);
  }
  const artists = [...byName.values()];
  for (const a of artists) {
    a.tracks.sort((x, y) => x.album.localeCompare(y.album) || (x.disc - y.disc) || (x.track - y.track));
  }
  artists.sort((a, b) => b.added - a.added);
  return artists;
}

// Group the library into albums: tracks in disc/track order, albums newest first.
export function groupAlbums(tracks: Track[]): AlbumEntry[] {
  const byKey = new Map<string, AlbumEntry>();
  for (const t of tracks) {
    if (!t.album) continue;
    const key = `${t.album}\u0000${t.albumArtist || t.artist}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { name: t.album, artist: t.albumArtist || t.artist, added: 0, tracks: [] };
      byKey.set(key, entry);
    }
    entry.tracks.push(t);
    entry.added = Math.max(entry.added, t.added);
  }
  const albums = [...byKey.values()];
  for (const a of albums) a.tracks.sort((x, y) => (x.disc - y.disc) || (x.track - y.track));
  albums.sort((a, b) => b.added - a.added);
  return albums;
}

// ---------------------------------------------------------------------------
// Picking from a list: fzf when available, numbered list otherwise.

function pick(lines: string[], header: string): number | null {
  if (lines.length === 0) return null;
  if (lines.length === 1) return 0;
  const hasFzf = Bun.spawnSync(["which", "fzf"]).exitCode === 0;
  if (hasFzf && process.stdin.isTTY) {
    const input = lines.map((l, i) => `${i}\t${l}`).join("\n");
    const res = Bun.spawnSync(
      ["fzf", "--reverse", "--height=~50%", "--delimiter=\t", "--with-nth=2..", `--header=${header}`],
      { stdin: Buffer.from(input), stdout: "pipe", stderr: "inherit" },
    );
    if (res.exitCode !== 0) return null; // cancelled
    return parseInt(res.stdout.toString());
  }
  lines.forEach((l, i) => console.log(`${String(i + 1).padStart(3)}  ${l}`));
  const answer = prompt(`${header} [1-${lines.length}]`);
  const n = answer ? parseInt(answer) : NaN;
  return n >= 1 && n <= lines.length ? n - 1 : null;
}

// Multi-select variant (fzf: tab marks several, enter confirms).
function pickMany(lines: string[], header: string): number[] {
  if (lines.length === 0) return [];
  if (lines.length === 1) return [0];
  const hasFzf = Bun.spawnSync(["which", "fzf"]).exitCode === 0;
  if (hasFzf && process.stdin.isTTY) {
    const input = lines.map((l, i) => `${i}\t${l}`).join("\n");
    const res = Bun.spawnSync(
      ["fzf", "--multi", "--reverse", "--height=~50%", "--delimiter=\t", "--with-nth=2..", `--header=${header} — tab selects several`],
      { stdin: Buffer.from(input), stdout: "pipe", stderr: "inherit" },
    );
    if (res.exitCode !== 0) return [];
    return res.stdout.toString().trim().split("\n").map((l) => parseInt(l));
  }
  const i = pick(lines, header); // ponytail: no-fzf fallback picks one at a time
  return i === null ? [] : [i];
}

// ---------------------------------------------------------------------------
// The TUI: browse panel left (songs/albums/playlists), player right.

const ESC = "\x1b[";
const BOLD = `${ESC}1m`, DIM = `${ESC}2m`, REV = `${ESC}7m`, RESET = `${ESC}0m`;

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s);

const TABS = ["songs", "albums", "playlists", "artists"] as const;

async function tui() {
  if (!process.stdout.isTTY) {
    console.error("the TUI needs a terminal; try `juke search <query>`");
    process.exit(1);
  }

  // Everything the browser shows comes from this one startup snapshot.
  const library = loadLibrary().sort((a, b) => b.added - a.added);
  const albums = groupAlbums(library);
  const artists = groupArtists(library);
  const playlistNames = loadPlaylistNames();
  const playlistCache = new Map<string, Track[]>();

  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J`); // alt screen, hide cursor
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // --- state
  let tab = 0;
  let cursor = 0, scroll = 0;
  let filter = "", typing = false;
  let drill: { kind: "album" | "playlist" | "artist"; title: string; tracks: Track[] } | null = null;
  let now: Now = nowPlaying();
  let lastFrame = ""; // art + border cache key
  let accent = "";
  let flashKey = "", flashUntil = 0; // status item to show briefly after its key
  let ctx: { ids: string[]; names: string[]; artists: string[] } = { ids: [], names: [], artists: [] };
  let ctxKey = ""; // play-context cache: refetch only when the context changes
  let middleMode: "preview" | "lyrics" | "queue" = "preview"; // what the middle panel shows
  let qCursor = 0; // selection inside the queue view
  let lyr: { id: string; lines: LyricLine[]; loading?: boolean } | null = null;
  let previewFetch: ReturnType<typeof setTimeout> | null = null;

  const restore = () => {
    process.stdout.write(`\x1b_Ga=d,d=A,q=2\x1b\\${ESC}?1049l${ESC}?25h`);
    process.stdin.setRawMode(false);
  };
  const cleanup = () => { restore(); process.exit(0); };
  onFatal = restore;
  process.on("SIGINT", cleanup);

  type Item = { primary: string; secondary: string; id: string };
  const items = (): Item[] => {
    if (drill) {
      return drill.tracks
        .filter((t) => !filter || matches(t, filter))
        .map((t) => ({ primary: t.name, secondary: t.artist, id: t.id }));
    }
    if (tab === 0) {
      return library
        .filter((t) => !filter || matches(t, filter))
        .map((t) => ({ primary: t.name, secondary: t.artist, id: t.id }));
    }
    if (tab === 1) {
      return albums
        .filter((a) => !filter || matches({ name: a.name, artist: a.artist, album: "" }, filter))
        .map((a) => ({ primary: a.name, secondary: a.artist, id: "" }));
    }
    if (tab === 3) {
      return artists
        .filter((a) => !filter || a.name.toLowerCase().includes(filter.toLowerCase()))
        .map((a) => ({ primary: a.name, secondary: `${a.tracks.length} songs`, id: "" }));
    }
    return playlistNames
      .filter((n) => !filter || n.toLowerCase().includes(filter.toLowerCase()))
      .map((n) => ({ primary: n, secondary: "", id: "" }));
  };

  // Map a filtered index back to the unfiltered collection.
  const selected = <T,>(all: T[], match: (x: T) => boolean): T | undefined =>
    all.filter(match)[cursor];

  type Region = { x: number; y: number; w: number; h: number };

  // What the preview panel shows: the track list behind the browse cursor.
  const previewData = (): { title: string; tracks: Track[]; markId: string; loading?: boolean } | null => {
    if (drill) {
      const t = selected(drill.tracks, (x) => !filter || matches(x, filter));
      return { title: drill.title, tracks: drill.tracks, markId: t ? t.id : "" };
    }
    if (tab === 0) {
      const t = selected(library, (x) => !filter || matches(x, filter));
      if (!t) return null;
      const a = albums.find((al) => al.name === t.album && al.artist === (t.albumArtist || t.artist));
      return a ? { title: a.name, tracks: a.tracks, markId: t.id } : null;
    }
    if (tab === 1) {
      const a = selected(albums, (x) => !filter || matches({ name: x.name, artist: x.artist, album: "" }, filter));
      return a ? { title: a.name, tracks: a.tracks, markId: "" } : null;
    }
    if (tab === 3) {
      const a = selected(artists, (x) => !filter || x.name.toLowerCase().includes(filter.toLowerCase()));
      return a ? { title: a.name, tracks: a.tracks, markId: "" } : null;
    }
    const name = selected(playlistNames, (n) => !filter || n.toLowerCase().includes(filter.toLowerCase()));
    if (!name) return null;
    if (!playlistCache.has(name)) {
      schedulePlaylistFetch(name);
      return { title: name, tracks: [], markId: "", loading: true };
    }
    return { title: name, tracks: playlistCache.get(name)!, markId: "" };
  };

  // Debounced so holding j/k over the playlists list doesn't fetch per row.
  const schedulePlaylistFetch = (name: string) => {
    if (previewFetch) clearTimeout(previewFetch);
    previewFetch = setTimeout(() => {
      if (!playlistCache.has(name)) playlistCache.set(name, loadPlaylistTracks(name));
      draw();
    }, 300);
  };

  const draw = () => {
    const cols = process.stdout.columns, rows = process.stdout.rows;
    if (cols < 40 || rows < 13) {
      process.stdout.write(`${ESC}2J${ESC}1;1H${DIM}terminal too small${RESET}`);
      lastFrame = "";
      return;
    }
    const H = rows - 1; // last row is the footer
    // Layout: three equal columns when there's width; stacked when there isn't.
    let player: Region, middle: Region | null = null, browse: Region | null = null;
    if (cols >= 90) {
      const w = Math.floor(cols / 3);
      player = { x: 1, y: 1, w, h: H };
      middle = { x: w + 1, y: 1, w, h: H };
      browse = { x: 2 * w + 1, y: 1, w: cols - 2 * w, h: H };
    } else if (rows >= 34) {
      // Stacked: the player keeps its vertical art-on-top arrangement, so it
      // gets the rows that needs (middle and browse split what remains).
      const hp = H - 16; // leave ≥8 rows each for the other two panels
      const hm = Math.floor((H - hp) / 2);
      player = { x: 1, y: 1, w: cols, h: hp };
      middle = { x: 1, y: hp + 1, w: cols, h: hm };
      browse = { x: 1, y: hp + hm + 1, w: cols, h: H - hp - hm };
    } else if (rows >= 20) {
      const hp = H - 10; // browse keeps ≥10 rows
      player = { x: 1, y: 1, w: cols, h: hp };
      browse = { x: 1, y: hp + 1, w: cols, h: H - hp };
    } else {
      player = { x: 1, y: 1, w: Math.min(cols, 48), h: H };
    }
    const stopped = now.state === "stopped" || !now.id;

    const frame = `${now.id}|${cols}x${rows}|${stopped}`;
    const newFrame = frame !== lastFrame;
    if (newFrame) {
      process.stdout.write(`\x1b_Ga=d,d=A,q=2\x1b\\${ESC}2J`);
      lastFrame = frame;
    }

    const at = (x: number, y: number, text: string) => process.stdout.write(`${ESC}${y};${x}H${text}`);
    const boxIn = (r: Region) => (y: number, text = "", visibleLen = 0) => {
      const fill = " ".repeat(Math.max(0, r.w - 4 - visibleLen));
      at(r.x, y, `${DIM}│${RESET} ${text}${fill} ${DIM}│${RESET}`);
    };
    // Bordered panel with a colored title; returns the inner-row writer.
    const panel = (r: Region, title: string) => {
      const inner = r.w - 2;
      const t = clip(title, inner - 4);
      at(r.x, r.y, `${DIM}╭─ ${RESET}${accent || BOLD}${t}${RESET}${DIM} ${"─".repeat(Math.max(0, inner - t.length - 3))}╮${RESET}`);
      const box = boxIn(r);
      for (let y = r.y + 1; y < r.y + r.h - 1; y++) box(y);
      at(r.x, r.y + r.h - 1, `${DIM}╰${"─".repeat(inner)}╯${RESET}`);
      return box;
    };

    // ---- browse panel
    if (browse) {
      const r = browse;
      const browseX = r.x;
      const inner = r.w - 2;
      const list = items();
      const visible = r.h - 3; // minus borders and the filter row
      cursor = Math.max(0, Math.min(cursor, list.length - 1));
      if (cursor < scroll) scroll = cursor;
      if (cursor >= scroll + visible) scroll = cursor - visible + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, list.length - visible)));

      // Title: the tab strip, or the drilled-into thing.
      let title: string;
      if (drill) {
        title = `${TABS[tab]} ▸ ${clip(drill.title, inner - TABS[tab].length - 8)}`;
        at(browseX, r.y, `${DIM}╭─ ${RESET}${BOLD}${title}${RESET}${DIM} ${"─".repeat(Math.max(0, inner - title.length - 3))}╮${RESET}`);
      } else if (TABS.join(" · ").length <= inner - 4) {
        const strip = TABS.map((t, i) => (i === tab ? `${RESET}${accent || BOLD}${t}${RESET}${DIM}` : t)).join(" · ");
        title = TABS.join(" · ");
        at(browseX, r.y, `${DIM}╭─ ${strip} ${"─".repeat(Math.max(0, inner - title.length - 3))}╮${RESET}`);
      } else {
        // narrow panel: full tab strip won't fit, show just the active tab
        title = `${tab + 1}/${TABS.length} ${TABS[tab]}`;
        at(browseX, r.y, `${DIM}╭─ ${RESET}${accent || BOLD}${title}${RESET}${DIM} ${"─".repeat(Math.max(0, inner - title.length - 3))}╮${RESET}`);
      }

      for (let i = 0; i < visible; i++) {
        const y = r.y + 1 + i;
        const item = list[scroll + i];
        let content: string;
        if (!item) {
          content = scroll + i === 0 && list.length === 0 ? ` ${DIM}no matches${RESET}` + " ".repeat(inner - 11) : " ".repeat(inner);
        } else {
          const isCursor = scroll + i === cursor;
          const playing = item.id && item.id === now.id ? "♪ " : "  ";
          const primary = clip(item.primary, inner - 4);
          const room = inner - 4 - primary.length;
          const secondary = item.secondary && room > 4 ? "  " + clip(item.secondary, room - 2) : "";
          const pad = " ".repeat(Math.max(0, inner - 4 - primary.length - secondary.length));
          content = isCursor
            ? `${REV} ${playing}${primary}${secondary}${pad} ${RESET}`
            : ` ${item.id && item.id === now.id ? (accent || BOLD) + playing + RESET : playing}${primary}${DIM}${secondary}${RESET}${pad} `;
        }
        at(browseX, y, `${DIM}│${RESET}${content}${DIM}│${RESET}`);
      }

      // Filter row: live input, or a hint, plus the match count.
      const count = `${list.length}`;
      const fLeft = clip(typing ? `/ ${filter}█` : filter ? `/ ${filter}` : "/ to filter", inner - count.length - 3);
      const fPad = " ".repeat(Math.max(0, inner - 2 - fLeft.length - count.length));
      at(browseX, r.y + r.h - 2, `${DIM}│${RESET} ${typing ? RESET : DIM}${fLeft}${RESET}${fPad}${DIM}${count} │${RESET}`);
      at(browseX, r.y + r.h - 1, `${DIM}╰${"─".repeat(inner)}╯${RESET}`);
    }

    // ---- middle panel: preview of the hovered item, lyrics, or the queue (⇥ cycles)
    if (middle) {
      const r = middle, inner = r.w - 2, w = inner - 2, roomRows = r.h - 2;
      if (middleMode === "queue") {
        const up = upcoming();
        const box = panel(r, `queue · ${up.length}`);
        if (up.length === 0) {
          const msg = "queue is empty — a adds the hovered song";
          box(r.y + Math.floor(r.h / 2), DIM + clip(msg, w) + RESET, Math.min(msg.length, w));
        } else {
          qCursor = Math.max(0, Math.min(qCursor, up.length - 1));
          let top = Math.max(0, qCursor - Math.floor(roomRows / 2));
          top = Math.min(top, Math.max(0, up.length - roomRows));
          for (let i = 0; i < Math.min(roomRows, up.length - top); i++) {
            const t = up[top + i];
            const isCur = top + i === qCursor;
            const num = String(top + i + 1).padStart(2);
            const nm = clip(t.name, w - 4);
            const room2 = w - 4 - nm.length;
            const art2 = t.artist && room2 > 4 ? "  " + clip(t.artist, room2 - 2) : "";
            if (isCur) {
              const pad = " ".repeat(Math.max(0, w - num.length - 1 - nm.length - art2.length));
              box(r.y + 1 + i, `${REV}${num} ${nm}${art2}${pad}${RESET}`, w);
            } else {
              box(r.y + 1 + i, `${DIM}${num}${RESET} ${nm}${DIM}${art2}${RESET}`, num.length + 1 + nm.length + art2.length);
            }
          }
        }
      } else if (middleMode === "lyrics") {
        const box = panel(r, "lyrics");
        if (stopped) {
          const msg = "nothing playing";
          box(r.y + Math.floor(r.h / 2), DIM + msg + RESET, msg.length);
        } else {
          let view: { text: string; cur: boolean }[];
          if (!lyr || lyr.id !== now.id || lyr.loading) {
            view = [{ text: "fetching lyrics…", cur: false }];
          } else if (lyr.lines.length === 0) {
            view = [{ text: "no lyrics found", cur: false }];
          } else {
            const synced = lyr.lines[0].t >= 0;
            let curLine = -1;
            if (synced) for (let i = 0; i < lyr.lines.length; i++) if (lyr.lines[i].t <= now.pos + 0.3) curLine = i;
            const flat: { text: string; line: number }[] = [];
            lyr.lines.forEach((ln, i) => wrapText(ln.text, w).forEach((text) => flat.push({ text, line: i })));
            let top: number;
            if (synced) {
              const curRow = flat.findIndex((f) => f.line === curLine);
              top = Math.max(0, (curRow < 0 ? 0 : curRow) - Math.floor(roomRows / 3));
            } else {
              // ponytail: unsynced lyrics scroll by song progress, close enough
              top = Math.floor((now.pos / Math.max(1, now.duration)) * Math.max(0, flat.length - roomRows));
            }
            top = Math.min(top, Math.max(0, flat.length - roomRows));
            view = flat.slice(top, top + roomRows).map((f) => ({ text: f.text, cur: synced && f.line === curLine }));
          }
          view.slice(0, roomRows).forEach((rw, i) => {
            const text = clip(rw.text, w);
            // bold default-fg (white on dark themes): the art accent can be
            // gray on monochrome covers and disappear into the dim lines
            box(r.y + 1 + i, rw.cur ? BOLD + text + RESET : DIM + text + RESET, text.length);
          });
        }
      } else {
        const pv = previewData();
        const box = panel(r, pv ? `preview ▸ ${pv.title}` : "preview");
        if (!pv) {
          const msg = "nothing to preview";
          box(r.y + Math.floor(r.h / 2), DIM + msg + RESET, msg.length);
        } else if (pv.loading) {
          box(r.y + 1, DIM + "loading…" + RESET, 8);
        } else {
          const markIdx = pv.tracks.findIndex((t) => t.id === pv.markId);
          let top = Math.max(0, (markIdx < 0 ? 0 : markIdx) - Math.floor(roomRows / 2));
          top = Math.min(top, Math.max(0, pv.tracks.length - roomRows));
          for (let i = 0; i < Math.min(roomRows, pv.tracks.length - top); i++) {
            const t = pv.tracks[top + i];
            const isMark = top + i === markIdx;
            const isNow = t.id === now.id;
            const num = String(top + i + 1).padStart(2);
            const nm = clip(t.name, w - 5);
            const marker = isNow ? `${accent || BOLD}♪${RESET}` : " ";
            box(r.y + 1 + i, `${DIM}${num}${RESET} ${marker} ${isMark ? BOLD + nm + RESET : nm}`, num.length + 3 + nm.length);
          }
        }
      }
    }

    // ---- player panel
    {
      const r = player, inner = r.w - 2, x = r.x;
      // Art on top, scaling with the window — bounded by panel width and
      // height, reserving rows for the up-next section when it can.
      let artA = Math.min(inner - 6, Math.max(28, (r.h - 19) * 2), (r.h - 13) * 2);
      artA -= artA % 2;
      const showArt = !stopped && artA >= 8;
      const artH = showArt ? artA / 2 : 0;

      const title = stopped ? "◼ stopped" : now.state === "paused" ? "▮▮ paused" : "♪ playing";
      const box = panel(r, title);

      if (newFrame && showArt) {
        const art = fetchArt(now.id);
        if (art) {
          drawArt(art.png, x + 1 + Math.floor((inner - artA) / 2), r.y + 2, artA, artH);
          const [rd, gn, bl] = liftAccent(art.accent);
          accent = `${ESC}38;2;${rd};${gn};${bl}m`;
        } else {
          accent = "";
        }
      }

      const flashing = (k: string) => flashKey === k && Date.now() < flashUntil;
      const statusItems: string[] = [];
      if (now.shuffle || flashing("shuffle")) statusItems.push(`⇄ ${now.shuffle ? "on" : "off"}`);
      if (now.repeat !== "off" || flashing("repeat")) statusItems.push(`↻ ${now.repeat}`);
      if (now.vol !== 100 || flashing("vol")) statusItems.push(`vol ${now.vol}`);

      if (stopped) {
        const msg = "nothing playing";
        box(r.y + Math.floor(r.h / 2), DIM + msg + RESET, msg.length);
      } else {
        const infoY = r.y + (showArt ? artH + 3 : 2);
        const name = clip(now.name, inner - 2);
        const artistAlbum = clip(`${now.artist} — ${now.album}`, inner - 2);
        box(infoY, BOLD + name + RESET, name.length);
        box(infoY + 1, DIM + artistAlbum + RESET, artistAlbum.length);
        // genre · year · plays · ♥ — only the parts that exist
        const parts = [now.genre, now.year ? `${now.year}` : "", now.plays ? `${now.plays} plays` : "", now.fav ? "♥" : ""]
          .filter(Boolean);
        const details = clip(parts.join(" · "), inner - 2);
        box(infoY + 2, DIM + details + RESET, details.length);
        const barW = inner - 2;
        box(infoY + 4, progressBar(now.pos, now.duration, barW, accent || BOLD, DIM, RESET), barW);
        const elapsed = fmtTime(now.pos), total = fmtTime(now.duration);
        box(infoY + 5, DIM + elapsed + " ".repeat(Math.max(1, barW - elapsed.length - total.length)) + total + RESET, barW);

        // Up next: the file queue (or native context), via upcoming().
        // Each entry is a wrapped name line over a dim wrapped artist line,
        // with a blank row between entries so they read as separate songs.
        const nextY = infoY + 7;
        const maxY = r.y + r.h - 4; // keep the bottom rows for the status section
        const up = upcoming();
        if (up.length > 0 && maxY - nextY >= 2) {
          // shuffle only shapes native contexts — the file queue plays in order
          const header = now.shuffle && !activeQueue() ? "up next ⇄" : "up next";
          at(x, nextY, `${DIM}├─ ${header} ${"─".repeat(Math.max(0, inner - header.length - 4))}┤${RESET}`);
          const w = inner - 2;
          let y = nextY + 1, j = 0, shown = 0;
          while (j < up.length && shown < 8 && y <= maxY) {
            const nameRows = wrapText(up[j].name || "", w);
            const artistRows = up[j].artist ? wrapText(up[j].artist, w) : [];
            if (y + nameRows.length + artistRows.length - 1 > maxY) break; // whole entry or nothing
            for (const t of nameRows) { const tt = clip(t, w); box(y++, tt, tt.length); }
            for (const t of artistRows) { const tt = clip(t, w); box(y++, DIM + tt + RESET, tt.length); }
            y++; // spacer
            j++; shown++;
          }
        }
        // Status items earn their space only when non-default — or for a
        // moment after their key was pressed, so toggling back to default
        // still gives feedback.
        if (statusItems.length > 0) {
          at(x, r.y + r.h - 3, `${DIM}├${"─".repeat(inner)}┤${RESET}`);
          const status = statusItems.join("   ");
          box(r.y + r.h - 2, DIM + status + RESET, status.length);
        }
      }
    }

    // ---- footer
    const hints = middleMode === "queue"
      ? "j/k select · enter play · x remove · J/K reorder · a add hovered · ⇥ panel · ␣ pause · q quit"
      : "enter play · a queue · l open · h back · / filter · 1-4 tabs · ⇥ panel · ␣ pause · ←/→ skip · +/- vol · s/r · q quit";
    at(1, rows, `${ESC}2K ` + DIM + clip(hints, cols - 2) + RESET);
  };

  // Fetch lyrics for the current track once, only while the view is open.
  const ensureLyrics = () => {
    if (middleMode !== "lyrics" || !now.id || (lyr && lyr.id === now.id)) return;
    const id = now.id;
    lyr = { id, lines: [], loading: true };
    fetchLyrics(now).then((lines) => {
      if (lyr && lyr.id === id) { lyr = { id, lines }; draw(); }
    });
  };

  const tick = () => {
    now = nowPlaying();
    // Only a real user playlist (specialKind "none") is a queue Music will
    // actually play through — single-song plays land in the special "Music"
    // master playlist, whose order never plays. That's not a queue.
    const key = now.plName && now.plSpecial === "none" ? `${now.plName}|${now.plCount}` : "";
    if (key !== ctxKey) {
      ctxKey = key;
      ctx = key ? contextTracks() : { ids: [], names: [], artists: [] };
    }
    ensureLyrics();
    draw();
  };
  // Music.app applies sets asynchronously; poll again shortly after acting
  // so the panel catches up.
  const act = (body: string, flash = "") => {
    if (flash) { flashKey = flash; flashUntil = Date.now() + 2500; }
    jxa(body + `; return "";`);
    tick();
    setTimeout(tick, 400);
  };
  const resetList = () => { cursor = 0; scroll = 0; filter = ""; typing = false; };

  const openSelection = () => {
    if (drill || tab === 0) return; // songs don't drill
    if (tab === 1) {
      const a = selected(albums, (x) => !filter || matches({ name: x.name, artist: x.artist, album: "" }, filter));
      if (!a) return;
      drill = { kind: "album", title: a.name, tracks: a.tracks };
    } else if (tab === 3) {
      const a = selected(artists, (x) => !filter || x.name.toLowerCase().includes(filter.toLowerCase()));
      if (!a) return;
      drill = { kind: "artist", title: a.name, tracks: a.tracks };
    } else {
      const name = selected(playlistNames, (n) => !filter || n.toLowerCase().includes(filter.toLowerCase()));
      if (!name) return;
      if (!playlistCache.has(name)) playlistCache.set(name, loadPlaylistTracks(name));
      drill = { kind: "playlist", title: name, tracks: playlistCache.get(name)! };
    }
    resetList();
    draw();
  };

  const playSelection = () => {
    if (drill) {
      const t = selected(drill.tracks, (x) => !filter || matches(x, filter));
      if (!t) return;
      playTracks(drill.tracks.map(qt), t.id);
    } else if (tab === 0) {
      const t = selected(library, (x) => !filter || matches(x, filter));
      if (t) playTracks([qt(t)]);
    } else if (tab === 1) {
      const a = selected(albums, (x) => !filter || matches({ name: x.name, artist: x.artist, album: "" }, filter));
      if (a) playTracks(a.tracks.map(qt));
    } else if (tab === 3) {
      const a = selected(artists, (x) => !filter || x.name.toLowerCase().includes(filter.toLowerCase()));
      if (a) playTracks(a.tracks.map(qt));
    } else {
      const name = selected(playlistNames, (n) => !filter || n.toLowerCase().includes(filter.toLowerCase()));
      if (name) playPlaylist(name);
    }
    tick();
    setTimeout(tick, 600); // give Music.app a beat, then show the new track
  };

  // The file queue, when it's really what Music is playing (or waiting
  // behind the current track). A file that disagrees with reality is stale
  // — the watcher stood down — and gets ignored.
  const activeQueue = (): Queue | null => {
    const q = readQueue();
    if (!q) return null;
    if (q.pos === -1 || q.tracks[q.pos]?.id === now.id) return q;
    return null;
  };

  // What's coming after the current track: the file queue when active,
  // otherwise the native play context (juke playlist).
  const upcoming = (): { id: string; name: string; artist: string }[] => {
    const q = activeQueue();
    if (q) return upNext(q);
    const curIdx = ctx.ids.indexOf(now.id);
    if (curIdx < 0) return [];
    return ctx.ids.slice(curIdx + 1).map((id, i) => ({
      id, name: ctx.names[curIdx + 1 + i] || "", artist: ctx.artists[curIdx + 1 + i] || "",
    }));
  };

  // Queue edits work on the file queue; editing while a native playlist
  // plays adopts its upcoming tracks into a fresh file queue first, and the
  // watcher owns playback from then on.
  const editableQueue = (): Queue | null => {
    const q = activeQueue();
    if (q) return q;
    const up = upcoming();
    if (up.length === 0 || !now.id) return null;
    return { tracks: [qt({ id: now.id, name: now.name, artist: now.artist }), ...up.map(qt)], pos: 0 };
  };

  const queueRemove = () => {
    const q = editableQueue();
    if (!q || upNext(q).length === 0) return;
    writeQueue(removeUpcoming(q, Math.min(qCursor, upNext(q).length - 1)));
    ensureWatcher();
    draw();
  };

  const queueMove = (d: number) => {
    const q = editableQueue();
    if (!q) return;
    const i = Math.min(qCursor, upNext(q).length - 1);
    const moved = moveUpcoming(q, i, d);
    if (!moved) return;
    writeQueue(moved);
    ensureWatcher();
    qCursor = i + d;
    draw();
  };

  const queueJump = () => {
    const q = editableQueue();
    if (!q || upNext(q).length === 0) return;
    const target = q.pos + 1 + Math.min(qCursor, upNext(q).length - 1);
    writeQueue({ tracks: q.tracks, pos: target });
    playTrack(q.tracks[target]);
    ensureWatcher();
    qCursor = 0;
    tick();
    setTimeout(tick, 600);
  };

  // `a`: add the hovered thing to the queue (song, or whole album/playlist).
  const queueSelection = () => {
    let sel: { id: string; name: string; artist: string }[] = [];
    if (drill) {
      const t = selected(drill.tracks, (x) => !filter || matches(x, filter));
      if (t) sel = [t];
    } else if (tab === 0) {
      const t = selected(library, (x) => !filter || matches(x, filter));
      if (t) sel = [t];
    } else if (tab === 1) {
      const a = selected(albums, (x) => !filter || matches({ name: x.name, artist: x.artist, album: "" }, filter));
      if (a) sel = a.tracks;
    } else if (tab === 3) {
      const a = selected(artists, (x) => !filter || x.name.toLowerCase().includes(filter.toLowerCase()));
      if (a) sel = a.tracks;
    } else {
      const name = selected(playlistNames, (n) => !filter || n.toLowerCase().includes(filter.toLowerCase()));
      if (name) {
        if (!playlistCache.has(name)) playlistCache.set(name, loadPlaylistTracks(name));
        sel = playlistCache.get(name)!;
      }
    }
    if (sel.length === 0) return;
    queueTracks(sel.map(qt));
    tick();
    setTimeout(tick, 600); // let Music settle, then show the new queue
  };

  process.stdin.on("data", (chunk: Buffer) => {
    for (const k of splitKeys(chunk.toString())) handleKey(k);
  });

  const handleKey = (k: string) => {
    if (k === "\x03") cleanup(); // ctrl-c always wins

    if (typing) {
      if (k === "\x1b") { typing = false; filter = ""; cursor = 0; scroll = 0; }
      else if (k === "\r") typing = false;
      else if (k === "\x7f") filter = filter.slice(0, -1);
      else if (k >= " " && k.length === 1) { filter += k; cursor = 0; scroll = 0; }
      draw();
      return;
    }

    // In queue mode, list keys drive the queue view; everything else falls
    // through to the shared bindings below.
    if (middleMode === "queue") {
      switch (k) {
        case "j": case `${ESC}B`: qCursor++; draw(); return;
        case "k": case `${ESC}A`: qCursor--; draw(); return;
        case "x": queueRemove(); return;
        case "J": queueMove(1); return;
        case "K": queueMove(-1); return;
        case "\r": queueJump(); return;
      }
    }

    switch (k) {
      case "j": case `${ESC}B`: cursor++; break;
      case "k": case `${ESC}A`: cursor--; break;
      case "g": cursor = 0; break;
      case "G": cursor = Infinity; break;
      case "\t":
        middleMode = middleMode === "preview" ? "lyrics" : middleMode === "lyrics" ? "queue" : "preview";
        ensureLyrics();
        break;
      case "1": case "2": case "3": case "4": tab = +k - 1; drill = null; resetList(); break;
      case "/": typing = true; filter = ""; cursor = 0; scroll = 0; break;
      case "l": openSelection(); return;
      case "h": case "\x1b":
        if (drill) { drill = null; resetList(); }
        else if (filter) { filter = ""; cursor = 0; scroll = 0; }
        break;
      case "\r": playSelection(); return;
      case "a": queueSelection(); return;
      case " ": act("music.playpause()"); return;
      case `${ESC}C`:
        if (queueNext()) { tick(); setTimeout(tick, 400); } else act("music.nextTrack()");
        return;
      case `${ESC}D`:
        if (queuePrev()) { tick(); setTimeout(tick, 400); } else act("music.backTrack()");
        return;
      case "+": case "=": act("music.soundVolume = Math.min(100, music.soundVolume() + 5)", "vol"); return;
      case "-": act("music.soundVolume = Math.max(0, music.soundVolume() - 5)", "vol"); return;
      case "s": act("const v = !music.shuffleEnabled(); music.shuffleEnabled = v", "shuffle"); return;
      case "r": act(`music.songRepeat = { off: "all", all: "one", one: "off" }[music.songRepeat()]`, "repeat"); return;
      case "q": cleanup();
      default: return;
    }
    draw();
  };

  process.stdout.on("resize", () => { lastFrame = ""; draw(); });
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// Commands (the extras — the TUI is the main way in)

function requireQuery(query: string, usage: string): string {
  if (!query) { console.error(usage); process.exit(1); }
  return query;
}

const HELP = `juke — Apple Music for the terminal

usage: juke [command] [query]

commands:
  (none)            open the TUI
  play [query]      pick a song and play it (no query: resume playback)
  queue [query]     pick songs to play next (no query: show the queue)
  play -q <query>   same as queue
  album <query>     pick an album, play it in order
  artist <query>    pick an artist, play everything by them
  playlist <query>  pick a playlist, play it
  search <query>    list matching songs without playing
  pause             toggle play/pause
  next, prev        skip to the next / previous track
  shuffle           toggle shuffle
  repeat            cycle repeat (off → all → one)

options:
  -h, --help        show this help

TUI keys:
  j/k or ↑/↓ move · enter play · l open album/playlist · h back
  a add to queue · 1/2/3/4 switch tabs · tab cycles preview/lyrics/queue
  queue view: j/k select · enter play · x remove · J/K reorder
  / filter · esc clear · space pause · ←/→ prev/next · +/- volume
  s shuffle · r repeat · q quit

lyrics come from lrclib.net (sends title/artist/duration when the view is open)`;

function songLabel(s: Song): string {
  return `${s.name}  ${DIM}${s.artist} — ${s.album}${RESET}`;
}

function queueCmd(query: string) {
  requireQuery(query, "usage: juke queue <query>");
  const songs = searchLibrary(query);
  if (songs.length === 0) { console.error(`no matches for "${query}"`); process.exit(1); }
  const picked = pickMany(songs.map(songLabel), "queue");
  if (picked.length === 0) return;
  const mode = queueTracks(picked.map((i) => qt(songs[i])));
  console.log(`queued ${picked.length} song${picked.length === 1 ? "" : "s"}${mode === "started" ? " — playing" : ""}`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const query = rest.join(" ");

  switch (cmd) {
    case undefined: {
      tui();
      return; // keeps the event loop alive
    }
    case "queue": {
      if (!query) { showQueue(); break; }
      queueCmd(query);
      break;
    }
    case "play": {
      if (rest[0] === "-q" || rest[0] === "--queue") { queueCmd(rest.slice(1).join(" ")); break; }
      if (!query) { jxa(`music.play(); return "";`); break; }
      const songs = searchLibrary(query);
      if (songs.length === 0) { console.error(`no matches for "${query}"`); process.exit(1); }
      const i = pick(songs.map(songLabel), "play");
      if (i === null) return;
      playTracks([qt(songs[i])]);
      console.log(`▶ ${songs[i].name} — ${songs[i].artist}`);
      break;
    }
    case "album": {
      requireQuery(query, "usage: juke album <query>");
      const q = query.toLowerCase();
      const albums = [...new Set(searchLibrary(query).map((s) => s.album))]
        .filter((a) => a.toLowerCase().includes(q));
      if (albums.length === 0) { console.error(`no album matches "${query}"`); process.exit(1); }
      const i = pick(albums, "album");
      if (i === null) return;
      playAlbum(albums[i]);
      console.log(`▶ ${albums[i]}`);
      break;
    }
    case "artist": {
      requireQuery(query, "usage: juke artist <query>");
      const q = query.toLowerCase();
      const names = [...new Set(searchLibrary(query).map((s) => s.artist))]
        .filter((a) => a.toLowerCase().includes(q));
      if (names.length === 0) { console.error(`no artist matches "${query}"`); process.exit(1); }
      const i = pick(names, "artist");
      if (i === null) return;
      playArtist(names[i]);
      console.log(`▶ ${names[i]}`);
      break;
    }
    case "playlist": {
      requireQuery(query, "usage: juke playlist <query>");
      const q = query.toLowerCase();
      const names: string[] = loadPlaylistNames().filter((n: string) => n.toLowerCase().includes(q));
      if (names.length === 0) { console.error(`no playlist matches "${query}"`); process.exit(1); }
      const i = pick(names, "playlist");
      if (i === null) return;
      playPlaylist(names[i]);
      console.log(`▶ ${names[i]}`);
      break;
    }
    case "search": {
      requireQuery(query, "usage: juke search <query>");
      const songs = searchLibrary(query);
      if (songs.length === 0) { console.log("no matches"); return; }
      for (const s of songs) console.log(songLabel(s));
      break;
    }
    case "pause": jxa(`music.playpause(); return "";`); break;
    case "next": if (!queueNext()) jxa(`music.nextTrack(); return "";`); break;
    case "prev": if (!queuePrev()) jxa(`music.backTrack(); return "";`); break;
    case "watch": watch(); return; // hidden: the queue-advancing watcher
    // Music.app applies sets asynchronously — reading right after returns the
    // old value. Report the value we set, don't read it back.
    case "shuffle": {
      const on = jxa(`const v = !music.shuffleEnabled(); music.shuffleEnabled = v; return JSON.stringify(v);`);
      console.log(`shuffle ${on ? "on" : "off"}`);
      break;
    }
    case "repeat": {
      const mode = jxa(`const v = { off: "all", all: "one", one: "off" }[music.songRepeat()]; music.songRepeat = v; return JSON.stringify(v);`);
      console.log(`repeat ${mode}`);
      break;
    }
    case "-h": case "--help": case "help":
      console.log(HELP);
      break;
    default:
      console.error(`juke: unknown command '${cmd}'`);
      console.error("try 'juke --help'");
      process.exit(1);
  }
}

if (import.meta.main) main();
