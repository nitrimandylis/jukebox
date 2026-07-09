#!/usr/bin/env bun
// music — Apple Music for the terminal.
// Music.app does the playing (its library is DRM'd, so nothing else can);
// this CLI is the remote control and the pretty face. Data flows over
// osascript: JXA for queries, AppleScript for the artwork dump. Album art
// renders as real pixels via the Kitty graphics protocol (Ghostty, kitty,
// WezTerm); everything else inherits the terminal's own theme.
//
// Usage: music                      live now-playing view
//        music play [query]         pick a song and play it (no query: resume)
//        music album <query>        pick an album, play it in order
//        music playlist <query>     pick a playlist, play it
//        music search <query>       list matches without playing
//        music pause | next | prev  transport
//        music shuffle | repeat     toggle / cycle
// Keys (live view): space pause · n/p skip · +/- volume · s/r modes · q quit

import { existsSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";

const CACHE = `${tmpdir()}/music-cli`; // per-track artwork cache
const FOOTER_MS = 6000; // keybind hints fade after this

// ---------------------------------------------------------------------------
// Talking to Music.app

function osascript(args: string[]): string {
  const res = Bun.spawnSync(["osascript", ...args], { stderr: "pipe" });
  if (res.exitCode !== 0) {
    const err = res.stderr.toString().trim();
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

type Song = { id: string; name: string; artist: string; album: string };

// Search every visible field (name, artist, album) of the library.
// ponytail: capped at 100 hits — each mapped property is one Apple Event.
function searchLibrary(query: string): Song[] {
  return jxa(`
    const hits = music.search(music.libraryPlaylists[0], { for: ${JSON.stringify(query)} });
    return JSON.stringify(hits.slice(0, 100).map(t => ({
      id: t.persistentID(), name: t.name(), artist: t.artist(), album: t.album(),
    })));
  `);
}

function playSongById(id: string) {
  jxa(`
    music.libraryPlaylists[0].tracks.whose({ persistentID: ${JSON.stringify(id)} })[0].play();
    return "";
  `);
}

// Music.app has no scriptable "play these tracks": the reliable trick is a
// throwaway playlist. Rebuild "music-cli" with the album in disc/track order
// and play that.
function playAlbum(album: string) {
  jxa(`
    const lib = music.libraryPlaylists[0];
    const spec = lib.tracks.whose({ album: ${JSON.stringify(album)} });
    const discs = spec.discNumber(), nums = spec.trackNumber();
    const order = discs.map((d, i) => i);
    order.sort((a, b) => (discs[a] - discs[b]) || (nums[a] - nums[b]));
    const old = music.userPlaylists.whose({ name: "music-cli" });
    while (old.length > 0) music.delete(old[0]);
    const pl = music.make({ new: "playlist", withProperties: { name: "music-cli" } });
    for (const i of order) music.duplicate(spec[i], { to: pl });
    pl.play();
    return "";
  `);
}

function playPlaylist(name: string) {
  jxa(`music.playlists.byName(${JSON.stringify(name)}).play(); return "";`);
}

type Now = {
  state: string; vol: number; shuffle: boolean; repeat: string;
  id: string; name: string; artist: string; album: string; duration: number; pos: number;
};

function nowPlaying(): Now {
  return jxa(`
    const out = { state: music.playerState(), vol: music.soundVolume(),
      shuffle: music.shuffleEnabled(), repeat: music.songRepeat(),
      id: "", name: "", artist: "", album: "", duration: 0, pos: 0 };
    try {
      const t = music.currentTrack;
      out.id = t.persistentID(); out.name = t.name(); out.artist = t.artist();
      out.album = t.album(); out.duration = t.duration();
      out.pos = music.playerPosition() || 0;
    } catch (e) {} // no current track
    return JSON.stringify(out);
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
// Pure rendering helpers (tested in music.test.ts)

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

// ---------------------------------------------------------------------------
// Live view: the vertical player.

const ESC = "\x1b[";
const BOLD = `${ESC}1m`, DIM = `${ESC}2m`, RESET = `${ESC}0m`;

async function liveView() {
  if (!process.stdout.isTTY) {
    console.error("the live view needs a terminal; try `music search <query>`");
    process.exit(1);
  }
  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J`); // alt screen, hide cursor
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let lastFrame = ""; // id|size|state key; borders + art redraw only when it changes
  let footerUntil = Date.now() + FOOTER_MS;
  let accent = "";

  const cleanup = () => {
    process.stdout.write(`\x1b_Ga=d,d=A,q=2\x1b\\${ESC}?1049l${ESC}?25h`);
    process.stdin.setRawMode(false);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);

  const render = () => {
    const cols = process.stdout.columns, rows = process.stdout.rows;
    const now = nowPlaying();
    const stopped = now.state === "stopped" || !now.id;

    // One lazygit-style panel: rounded border, state in the title, a divider
    // before the status row. Art sits small and centered near the top.
    const W = Math.min(cols - 2, 48); // panel width, borders included
    const inner = W - 2;
    if (cols < 24 || rows < 13) {
      process.stdout.write(`${ESC}2J${ESC}1;1H${DIM}terminal too small${RESET}`);
      lastFrame = "";
      return;
    }
    let artA = Math.min(inner - 8, (rows - 15) * 2, 28); // quarter-scale cover
    artA -= artA % 2;
    const showArt = !stopped && artA >= 10;
    const artH = showArt ? artA / 2 : 0;
    const panelH = artH + 11;
    const left = Math.max(1, Math.floor((cols - W) / 2) + 1);
    const top = Math.max(1, Math.floor((rows - panelH - 2) / 2) + 1);

    const at = (y: number, text: string) => process.stdout.write(`${ESC}${y};${left}H${text}`);
    const boxRow = (y: number, text = "", visible = 0) => {
      const fill = " ".repeat(Math.max(0, inner - 2 - visible));
      at(y, `${DIM}│${RESET} ${text}${fill} ${DIM}│${RESET}`);
    };
    const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

    // Rows inside the panel, top border = `top`.
    const artTop = top + 2;
    const nameRow = artTop + artH + 1;
    const barRow = nameRow + 3;
    const divRow = barRow + 2;
    const frame = `${now.id}|${cols}x${rows}|${stopped}`;

    if (frame !== lastFrame) {
      process.stdout.write(`\x1b_Ga=d,d=A,q=2\x1b\\${ESC}2J`);
      for (let y = top + 1; y < top + panelH - 1; y++) boxRow(y);
      at(divRow, DIM + "├" + "─".repeat(inner) + "┤" + RESET);
      at(top + panelH - 1, DIM + "╰" + "─".repeat(inner) + "╯" + RESET);
      if (showArt) {
        const art = fetchArt(now.id);
        if (art) {
          drawArt(art.png, left + 1 + Math.floor((inner - artA) / 2), artTop, artA, artH);
          const [r, g, b] = liftAccent(art.accent);
          accent = `${ESC}38;2;${r};${g};${b}m`;
        } else {
          accent = "";
        }
      }
      lastFrame = frame;
    }

    // Title carries the player state, tinted with the cover's accent.
    const title = stopped ? "◼ stopped" : now.state === "paused" ? "▮▮ paused" : "♪ playing";
    at(top, `${DIM}╭─ ${RESET}${accent || BOLD}${title}${RESET}${DIM} ${"─".repeat(Math.max(0, inner - title.length - 3))}╮${RESET}`);

    if (stopped) {
      const msg = "nothing playing — music play <query>";
      boxRow(nameRow, DIM + clip(msg, inner - 2) + RESET, Math.min(msg.length, inner - 2));
      boxRow(top + panelH - 2, "");
      return;
    }

    const name = clip(now.name, inner - 2);
    const artistAlbum = clip(`${now.artist} — ${now.album}`, inner - 2);
    boxRow(nameRow, BOLD + name + RESET, name.length);
    boxRow(nameRow + 1, DIM + artistAlbum + RESET, artistAlbum.length);
    const barW = inner - 2;
    boxRow(barRow, progressBar(now.pos, now.duration, barW, accent || BOLD, DIM, RESET), barW);
    const elapsed = fmtTime(now.pos), total = fmtTime(now.duration);
    boxRow(barRow + 1, DIM + elapsed + " ".repeat(Math.max(1, barW - elapsed.length - total.length)) + total + RESET, barW);
    const status = `⇄ ${now.shuffle ? "on" : "off"}   ↻ ${now.repeat}   vol ${now.vol}`;
    boxRow(divRow + 1, DIM + status + RESET, status.length);
    const hints = "␣ pause · n/p skip · +/- vol · s/r · q quit";
    at(top + panelH + 1, `${ESC}2K` + (Date.now() < footerUntil ? DIM + clip(hints, W) + RESET : ""));
  };

  // Music.app applies sets asynchronously; render now and again shortly
  // after so the status line catches up.
  const act = (body: string) => { jxa(body + `; return "";`); render(); setTimeout(render, 400); };
  process.stdin.on("data", (key: Buffer) => {
    footerUntil = Date.now() + FOOTER_MS; // any key brings the hints back
    switch (key.toString()) {
      case " ": act("music.playpause()"); break;
      case "n": act("music.nextTrack()"); break;
      case "p": act("music.backTrack()"); break;
      case "+": case "=": act("music.soundVolume = Math.min(100, music.soundVolume() + 5)"); break;
      case "-": act("music.soundVolume = Math.max(0, music.soundVolume() - 5)"); break;
      case "s": act("music.shuffleEnabled = !music.shuffleEnabled()"); break;
      case "r": act(`music.songRepeat = { off: "all", all: "one", one: "off" }[music.songRepeat()]`); break;
      case "q": case "\x03": cleanup();
    }
  });

  process.stdout.on("resize", () => { lastArtId = ""; render(); });
  render();
  setInterval(render, 1000);
}

// ---------------------------------------------------------------------------
// Commands

function requireQuery(query: string, usage: string): string {
  if (!query) { console.error(usage); process.exit(1); }
  return query;
}

function songLabel(s: Song): string {
  return `${s.name}  ${DIM}${s.artist} — ${s.album}${RESET}`;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const query = rest.join(" ");

  switch (cmd) {
    case undefined: {
      liveView();
      return; // keeps the event loop alive
    }
    case "play": {
      if (!query) { jxa(`music.play(); return "";`); break; }
      const songs = searchLibrary(query);
      if (songs.length === 0) { console.error(`no matches for "${query}"`); process.exit(1); }
      const i = pick(songs.map(songLabel), "play");
      if (i === null) return;
      playSongById(songs[i].id);
      console.log(`▶ ${songs[i].name} — ${songs[i].artist}`);
      break;
    }
    case "album": {
      requireQuery(query, "usage: music album <query>");
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
    case "playlist": {
      requireQuery(query, "usage: music playlist <query>");
      const q = query.toLowerCase();
      const names: string[] = jxa(`return JSON.stringify(music.userPlaylists.name());`)
        .filter((n: string) => n.toLowerCase().includes(q) && n !== "music-cli");
      if (names.length === 0) { console.error(`no playlist matches "${query}"`); process.exit(1); }
      const i = pick(names, "playlist");
      if (i === null) return;
      playPlaylist(names[i]);
      console.log(`▶ ${names[i]}`);
      break;
    }
    case "search": {
      requireQuery(query, "usage: music search <query>");
      const songs = searchLibrary(query);
      if (songs.length === 0) { console.log("no matches"); return; }
      for (const s of songs) console.log(songLabel(s));
      break;
    }
    case "pause": jxa(`music.playpause(); return "";`); break;
    case "next": jxa(`music.nextTrack(); return "";`); break;
    case "prev": jxa(`music.backTrack(); return "";`); break;
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
    default:
      console.error("usage: music [play|album|playlist|search|pause|next|prev|shuffle|repeat] [query]");
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.main) main();
