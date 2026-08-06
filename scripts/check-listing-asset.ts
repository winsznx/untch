/**
 * The marketplace avatar, checked rather than remembered.
 *
 * OKX requires a listing asset that is exactly 1:1 with no baked-in rounded corners. Both are easy to
 * satisfy once and lose later: a designer re-exports with a rounded-square mask because that is how
 * the marketplace renders it anyway, and the result looks right in every preview and wrong beside
 * every other listing, because the platform applies its own mask on top and the corners get clipped
 * twice.
 *
 * Neither property survives in a README. This reads the bytes the marketplace will actually fetch.
 *
 * WHY IT DECODES THE PNG BY HAND
 *
 * The aspect ratio is in the IHDR chunk and needs no decoding. Transparent corners do — and adding an
 * image library to the money repo's dependency tree to read four pixels is a worse trade than sixty
 * lines using node's own zlib. The decoder below handles exactly the shape this asset is (8-bit RGBA,
 * non-interlaced) and refuses anything else rather than guessing, because a decoder that quietly
 * mishandles a format it does not support would report corners that were never examined.
 */

import { inflateSync } from "node:zlib";

const ASSET_URL =
  "https://static.okx.com/cdn/web3/wallet/marketplace/headimages/agent/avatar/c00d3425-c37e-4343-8a6a-5d25ca831278.png";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Png {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly pixels: Buffer;
}

function decodePng(data: Buffer): Png {
  if (!data.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("the asset is not a PNG");

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colourType = body[9]!;
      interlace = body[12]!;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || colourType !== 6) {
    throw new Error(
      `this checker reads 8-bit RGBA only, and the asset is bit depth ${bitDepth} colour type ${colourType}. ` +
        "Refusing rather than reporting corners it never examined.",
    );
  }
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported by this checker");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-scanline filters. Each row is prefixed with one filter-type byte.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = line[x]!;
      const a = x >= 4 ? out[x - 4]! : 0;
      const b = prior ? prior[x]! : 0;
      const c = prior && x >= 4 ? prior[x - 4]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG scanline filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
  }

  return { width, height, pixels };
}

export interface AssetVerdict {
  readonly ok: boolean;
  readonly width: number;
  readonly height: number;
  readonly problems: readonly string[];
}

export function inspectAsset(data: Buffer): AssetVerdict {
  const png = decodePng(data);
  const problems: string[] = [];

  if (png.width !== png.height) {
    problems.push(`is ${png.width}x${png.height}, and a marketplace avatar must be exactly 1:1`);
  }

  const alphaAt = (x: number, y: number) => png.pixels[(y * png.width + x) * 4 + 3]!;
  const corners: [string, number, number][] = [
    ["top-left", 0, 0],
    ["top-right", png.width - 1, 0],
    ["bottom-left", 0, png.height - 1],
    ["bottom-right", png.width - 1, png.height - 1],
  ];
  for (const [name, x, y] of corners) {
    if (alphaAt(x, y) < 255) {
      problems.push(
        `has a transparent ${name} corner (alpha ${alphaAt(x, y)}), which is a baked-in rounded mask — ` +
          "the marketplace applies its own, and two masks clip the artwork twice",
      );
    }
  }

  /**
   * Transparent padding is the other way a square file renders as a non-square mark: the canvas is
   * 1:1 and the visible artwork inside it is not. Measured as the bounding box of everything with
   * any opacity at all.
   */
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (alphaAt(x, y) === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX >= 0) {
    const markWidth = maxX - minX + 1;
    const markHeight = maxY - minY + 1;
    const ratio = markWidth / markHeight;
    if (ratio < 0.98 || ratio > 1.02) {
      problems.push(
        `has transparent padding that leaves the visible mark ${markWidth}x${markHeight} (ratio ` +
          `${ratio.toFixed(3)}), so it renders as a non-square logo inside a square file`,
      );
    }
  } else {
    problems.push("is fully transparent");
  }

  return { ok: problems.length === 0, width: png.width, height: png.height, problems };
}

async function main(): Promise<void> {
  const res = await fetch(ASSET_URL, { redirect: "manual" });
  if (res.status !== 200) {
    console.error(`[asset] the listing avatar answered HTTP ${res.status} — a reviewer would see a broken image`);
    process.exit(1);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    console.error(`[asset] the listing avatar is served as ${contentType}, which is not an image`);
    process.exit(1);
  }

  const verdict = inspectAsset(Buffer.from(await res.arrayBuffer()));
  if (!verdict.ok) {
    console.error("[asset] the listing avatar must not be published:");
    for (const p of verdict.problems) console.error(`  it ${p}`);
    process.exit(1);
  }
  console.log(
    `[asset] ok — ${verdict.width}x${verdict.height}, square, fully opaque corners, no transparent padding`,
  );
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
if (isMain) void main();
