import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectAsset } from "../check-listing-asset";

/**
 * The checker is only worth having if it catches the thing it was written for.
 *
 * A verdict of "ok" on the real asset proves nothing on its own — a function that always returns ok
 * would pass that too. So every failure mode is constructed here as an actual PNG and fed through the
 * real decoder: a rounded-corner mask, a non-square canvas, and transparent padding that makes a
 * square file render as a non-square mark.
 */

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** An 8-bit RGBA PNG built from a per-pixel function, using filter 0 so the bytes are unambiguous. */
function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const at = y * (stride + 1) + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const OPAQUE = (): [number, number, number, number] => [22, 22, 92, 255];

describe("the listing asset checker", () => {
  test("a square, fully opaque image passes", () => {
    const verdict = inspectAsset(makePng(64, 64, OPAQUE));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.width, 64);
    assert.equal(verdict.height, 64);
    assert.deepEqual(verdict.problems, []);
  });

  test("a non-square image is refused and both dimensions are named", () => {
    const verdict = inspectAsset(makePng(64, 32, OPAQUE));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => p.includes("64x32") && p.includes("1:1")));
  });

  /** The failure this exists for: a mask baked in because the marketplace rounds corners anyway. */
  test("a baked-in rounded corner is refused, and the corner is named", () => {
    const size = 64;
    const radius = 8;
    const verdict = inspectAsset(
      makePng(size, size, (x, y) => {
        const inCorner =
          (x < radius && y < radius && (x - radius) ** 2 + (y - radius) ** 2 > radius ** 2) ||
          (x >= size - radius && y < radius);
        return inCorner ? [0, 0, 0, 0] : OPAQUE();
      }),
    );
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => p.includes("top-left")), "the top-left corner was not reported");
    assert.ok(verdict.problems.some((p) => p.includes("top-right")), "the top-right corner was not reported");
    assert.ok(verdict.problems.some((p) => p.includes("rounded mask")));
  });

  /** A 1:1 canvas whose visible artwork is not 1:1 renders as a squashed logo beside every other. */
  test("transparent padding that makes the mark non-square is refused", () => {
    const verdict = inspectAsset(
      makePng(64, 64, (x, y) => (y >= 20 && y < 44 ? OPAQUE() : [0, 0, 0, 0])),
    );
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => p.includes("transparent padding")));
  });

  test("a fully transparent image is refused", () => {
    const verdict = inspectAsset(makePng(64, 64, () => [0, 0, 0, 0]));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => p.includes("fully transparent")));
  });

  /** Padding that keeps the mark square is fine — plenty of correct logos have breathing room. */
  test("symmetric padding that keeps the mark square passes", () => {
    const verdict = inspectAsset(
      makePng(64, 64, (x, y) => (x >= 8 && x < 56 && y >= 8 && y < 56 ? OPAQUE() : [0, 0, 0, 255])),
    );
    assert.equal(verdict.ok, true);
  });

  /** A decoder that guessed at an unsupported format would report corners it never examined. */
  test("a format this checker cannot read is refused rather than guessed at", () => {
    const notPng = Buffer.from("GIF89a and then some bytes");
    assert.throws(() => inspectAsset(notPng), /not a PNG/);
  });

  /**
   * The real asset, from bytes committed alongside this test.
   *
   * The CI check fetches the live CDN URL, because what the marketplace renders is what the CDN
   * serves. This asserts the same bytes offline, so a network failure in CI is distinguishable from
   * an asset that actually regressed.
   */
  test("the asset stored for ASP #6086 passes every rule", () => {
    const bytes = readFileSync(join(import.meta.dirname, "fixtures", "asp-6086-avatar.png"));
    const verdict = inspectAsset(bytes);
    assert.equal(verdict.ok, true, verdict.problems.join("; "));
    assert.equal(verdict.width, 1024);
    assert.equal(verdict.height, 1024);
  });
});
