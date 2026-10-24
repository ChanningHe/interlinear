// Renders the extension icon as PNG with no dependencies: a rounded square
// with alternating "source / translation" text lines.
import { deflateSync } from "node:zlib";

const BG = [37, 99, 235];
const LINE = [255, 255, 255];
const LINE_ALT = [147, 197, 253];
const SUPERSAMPLE = 4;
const RADIUS = 0.22;
// [y, width, colour] in unit coordinates.
const LINES = [
  [0.27, 0.6, LINE],
  [0.42, 0.42, LINE_ALT],
  [0.58, 0.6, LINE],
  [0.73, 0.42, LINE_ALT],
];
const LINE_HALF_HEIGHT = 0.05;
const LEFT = 0.2;

function insideRoundedSquare(x, y) {
  const dx = Math.max(RADIUS - x, x - (1 - RADIUS), 0);
  const dy = Math.max(RADIUS - y, y - (1 - RADIUS), 0);
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

function colourAt(x, y) {
  if (!insideRoundedSquare(x, y)) return undefined;
  const line = LINES.find(([ly, w]) => Math.abs(y - ly) <= LINE_HALF_HEIGHT && x >= LEFT && x <= LEFT + w);
  return line ? line[2] : BG;
}

function pixel(size, px, py) {
  const acc = [0, 0, 0, 0];
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const c = colourAt((px + (sx + 0.5) / SUPERSAMPLE) / size, (py + (sy + 0.5) / SUPERSAMPLE) / size);
      if (!c) continue;
      acc[0] += c[0];
      acc[1] += c[1];
      acc[2] += c[2];
      acc[3] += 1;
    }
  }
  const n = acc[3];
  return n === 0 ? [0, 0, 0, 0] : [acc[0] / n, acc[1] / n, acc[2] / n, (255 * n) / SUPERSAMPLE ** 2].map(Math.round);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function renderIcon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(pixel(size, x, y), row + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
