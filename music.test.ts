import { expect, test } from "bun:test";
import { fmtTime, progressBar, bmpPixel, liftAccent } from "./music.ts";

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
