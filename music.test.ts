import { expect, test } from "bun:test";
import { fmtTime, progressBar, bmpPixel, liftAccent, matches, groupAlbums, type Track } from "./music.ts";

const track = (over: Partial<Track>): Track => ({
  id: "X", name: "", artist: "", album: "", albumArtist: "", disc: 1, track: 1, added: 0, ...over,
});

test("splitKeys separates batched input, keeps escape sequences whole", () => {
  const { splitKeys } = require("./music.ts");
  expect(splitKeys("/gnx")).toEqual(["/", "g", "n", "x"]);
  expect(splitKeys("\x1b[A\x1b[Bj")).toEqual(["\x1b[A", "\x1b[B", "j"]);
  expect(splitKeys("\x1b")).toEqual(["\x1b"]); // lone esc
});

test("parseLyrics handles synced LRC, plain text, and nothing", () => {
  const { parseLyrics } = require("./music.ts");
  const lrc = "[00:12.34] first line\n[01:02.5]second\nnot a timestamp";
  expect(parseLyrics(lrc, null)).toEqual([
    { t: 12.34, text: "first line" },
    { t: 62.5, text: "second" },
  ]);
  expect(parseLyrics(null, "just\ntext")).toEqual([
    { t: -1, text: "just" },
    { t: -1, text: "text" },
  ]);
  expect(parseLyrics(null, null)).toEqual([]);
});

test("wrapText wraps at word boundaries", () => {
  const { wrapText } = require("./music.ts");
  expect(wrapText("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  expect(wrapText("", 10)).toEqual([""]);
  expect(wrapText("short", 10)).toEqual(["short"]);
});

test("groupArtists sorts tracks by album/disc/track, artists newest-first", () => {
  const { groupArtists } = require("./music.ts");
  const artists = groupArtists([
    track({ id: "b2", artist: "Old Guy", album: "B", track: 2, added: 10 }),
    track({ id: "b1", artist: "Old Guy", album: "B", track: 1, added: 5 }),
    track({ id: "a1", artist: "Old Guy", album: "A", track: 9, added: 1 }),
    track({ id: "n1", artist: "New Guy", added: 999 }),
    track({ id: "x", artist: "" }), // no artist — dropped
  ]);
  expect(artists.map((a: any) => a.name)).toEqual(["New Guy", "Old Guy"]);
  expect(artists[1].tracks.map((t: any) => t.id)).toEqual(["a1", "b1", "b2"]);
});

test("matches is case-insensitive across name/artist/album", () => {
  const t = track({ name: "Not Like Us", artist: "Kendrick Lamar", album: "GNX" });
  expect(matches(t, "kendrick")).toBe(true);
  expect(matches(t, "gnx")).toBe(true);
  expect(matches(t, "LIKE US")).toBe(true);
  expect(matches(t, "drake")).toBe(false);
});

test("groupAlbums sorts tracks by disc/track and albums newest-first", () => {
  const albums = groupAlbums([
    track({ id: "a2", album: "Old", track: 2, added: 100 }),
    track({ id: "a1", album: "Old", track: 1, added: 50 }),
    track({ id: "b1", album: "New", added: 999, albumArtist: "Someone" }),
    track({ id: "nope", album: "" }), // no album — dropped
  ]);
  expect(albums.map((a) => a.name)).toEqual(["New", "Old"]);
  expect(albums[1].tracks.map((t) => t.id)).toEqual(["a1", "a2"]);
  expect(albums[0].artist).toBe("Someone");
});

test("fmtTime", () => {
  expect(fmtTime(0)).toBe("0:00");
  expect(fmtTime(83)).toBe("1:23");
  expect(fmtTime(600.9)).toBe("10:00");
  expect(fmtTime(-5)).toBe("0:00");
});

test("progressBar fills proportionally and keeps its width", () => {
  const bar = progressBar(30, 60, 10, "<C>", "<D>", "<R>");
  expect(bar).toBe("<C>━━━━━╸<R><D>────<R>");
  // stripped of color codes, always exactly `width` characters
  const strip = (s: string) => s.replace(/<[CDR]>/g, "");
  expect(strip(progressBar(0, 60, 10, "<C>", "<D>", "<R>")).length).toBe(10);
  expect(strip(progressBar(60, 60, 10, "<C>", "<D>", "<R>")).length).toBe(10);
  expect(strip(progressBar(5, 0, 10, "<C>", "<D>", "<R>")).length).toBe(10); // unknown duration
});

test("bmpPixel reads BGR at the header offset", () => {
  // minimal fake BMP: offset field at byte 10 says pixels start at 54
  const buf = new Uint8Array(57);
  buf[10] = 54;
  buf[54] = 0x76; buf[55] = 0x74; buf[56] = 0x5d; // B G R
  expect(bmpPixel(buf)).toEqual([0x5d, 0x74, 0x76]);
});

test("liftAccent brightens dark colors, leaves bright ones alone", () => {
  expect(Math.max(...liftAccent([30, 20, 10]))).toBe(150);
  expect(liftAccent([200, 100, 50])).toEqual([200, 100, 50]);
});
