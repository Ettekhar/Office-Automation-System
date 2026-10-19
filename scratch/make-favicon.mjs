/**
 * scratch/make-favicon.mjs
 *
 * Builds public/favicon.ico from the same geometry as public/favicon.svg.
 *
 * No dependencies: the 64-unit design (dark rounded tile + green bolt) is
 * rasterised here with 4x supersampling and written as a classic ICO with
 * 32bpp BMP entries at 16/32/48 px — the sizes Windows/Chrome/Edge pick from,
 * for anything that ignores the SVG icon.
 *
 * Run:  node scratch/make-favicon.mjs
 * Prints an ASCII proof of the 32px raster so the shape is verifiable in text.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'public', 'favicon.ico');

// ── the design, in a 64-unit box (identical numbers to favicon.svg) ──────────
const TILE = { size: 64, radius: 14, color: [0x14, 0x16, 0x1b] };
const BOLT = {
  top: [0x34, 0xd3, 0x99],   // gradient start (#34D399)
  bottom: [0x05, 0x96, 0x69], // gradient end   (#059669)
  points: [
    [34.6, 6], [8.6, 37.2], [32, 37.2], [29.4, 58], [55.4, 26.8], [32, 26.8],
  ],
};

/** Ray-casting point-in-polygon (even-odd). */
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside a rounded square? (0,0)-(size,size) with the given corner radius. */
function inRoundedSquare(x, y, size, r) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Renders one size → { w, h, rgba: Uint8ClampedArray } using 4x4 supersampling. */
function render(size) {
  const SS = 4;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const scale = size / TILE.size;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tileA = 0;
      let boltA = 0;
      let boltR = 0;
      let boltG = 0;
      let boltB = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // sample point in 64-unit space
          const ux = (px + (sx + 0.5) / SS) / scale;
          const uy = (py + (sy + 0.5) / SS) / scale;
          if (inRoundedSquare(ux, uy, TILE.size, TILE.radius)) tileA++;
          if (inPolygon(ux, uy, BOLT.points)) {
            boltA++;
            const t = Math.min(1, Math.max(0, (uy - 6) / 52)); // gradient down the bolt
            boltR += BOLT.top[0] + (BOLT.bottom[0] - BOLT.top[0]) * t;
            boltG += BOLT.top[1] + (BOLT.bottom[1] - BOLT.top[1]) * t;
            boltB += BOLT.top[2] + (BOLT.bottom[2] - BOLT.top[2]) * t;
          }
        }
      }

      const n = SS * SS;
      const ta = tileA / n;
      const ba = boltA / n;
      // composite: bolt over tile (both premultiplied onto transparent)
      const a = ta + ba * (1 - ta);
      let r = 0;
      let g = 0;
      let b = 0;
      if (a > 0) {
        const tR = TILE.color[0] * ta;
        const tG = TILE.color[1] * ta;
        const tB = TILE.color[2] * ta;
        const bR = boltA ? (boltR / boltA) * ba : 0;
        const bG = boltA ? (boltG / boltA) * ba : 0;
        const bB = boltA ? (boltB / boltA) * ba : 0;
        r = (bR + tR * (1 - ba)) / a;
        g = (bG + tG * (1 - ba)) / a;
        b = (bB + tB * (1 - ba)) / a;
      }

      const o = (py * size + px) * 4;
      rgba[o] = Math.round(r);
      rgba[o + 1] = Math.round(g);
      rgba[o + 2] = Math.round(b);
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return { w: size, h: size, rgba };
}

/** One 32bpp BMP (BITMAPINFOHEADER) entry for the ICO: bottom-up BGRA + AND mask. */
function bmpEntry(img) {
  const { w, h, rgba } = img;
  const xorRow = w * 4;
  const andRow = Math.ceil(w / 32) * 4; // 1bpp rows are 4-byte aligned
  const xorSize = xorRow * h;
  const andSize = andRow * h;
  const buf = Buffer.alloc(40 + xorSize + andSize);

  buf.writeUInt32LE(40, 0);            // biSize
  buf.writeInt32LE(w, 4);              // biWidth
  buf.writeInt32LE(h * 2, 8);          // biHeight (XOR + AND)
  buf.writeUInt16LE(1, 12);            // biPlanes
  buf.writeUInt16LE(32, 14);           // biBitCount
  buf.writeUInt32LE(0, 16);            // biCompression = BI_RGB
  buf.writeUInt32LE(xorSize, 20);      // biSizeImage

  // XOR bitmap: BGRA, rows bottom-up
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * 4;
      const d = 40 + y * xorRow + x * 4;
      buf[d] = rgba[s + 2];      // B
      buf[d + 1] = rgba[s + 1];  // G
      buf[d + 2] = rgba[s];      // R
      buf[d + 3] = rgba[s + 3];  // A
    }
  }
  // AND mask: 1 bit where fully transparent (renderers mostly use alpha)
  const andBase = 40 + xorSize;
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const a = rgba[(srcY * w + x) * 4 + 3];
      if (a === 0) buf[andBase + y * andRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return buf;
}

// ── build the .ico ───────────────────────────────────────────────────────────
const sizes = [16, 32, 48];
const images = sizes.map(render);
const entries = images.map(bmpEntry);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);          // type: icon
header.writeUInt16LE(images.length, 4);

const dir = Buffer.alloc(16 * images.length);
let offset = 6 + dir.length;
images.forEach((img, i) => {
  const o = i * 16;
  dir.writeUInt8(img.w >= 256 ? 0 : img.w, o);
  dir.writeUInt8(img.h >= 256 ? 0 : img.h, o + 1);
  dir.writeUInt8(0, o + 2);          // palette count
  dir.writeUInt8(0, o + 3);          // reserved
  dir.writeUInt16LE(1, o + 4);       // planes
  dir.writeUInt16LE(32, o + 6);      // bpp
  dir.writeUInt32LE(entries[i].length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += entries[i].length;
});

fs.writeFileSync(outFile, Buffer.concat([header, dir, ...entries]));
console.log(`wrote ${outFile} (${fs.statSync(outFile).size} bytes, sizes ${sizes.join('/')})`);

// ── ASCII proof of the 32px raster (2 chars wide per pixel for aspect) ──────
const img = images[1];
console.log('\n32px raster (# = green bolt, . = tile, space = transparent):');
for (let y = 0; y < img.h; y += 1) {
  let line = '';
  for (let x = 0; x < img.w; x++) {
    const o = (y * img.w + x) * 4;
    const [r, g, b, a] = [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
    const ch = a < 40 ? ' ' : (g > r + 24 && g > b + 24 ? '#' : '.');
    line += ch + ch;
  }
  console.log(line);
}
