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
