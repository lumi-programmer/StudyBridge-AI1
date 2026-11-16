// Rasterizes the brand artwork from web/assets/favicon.svg into the PNG icon set
// the manifest and iOS need. No image library: a PNG encoder over node:zlib plus
// a supersampled rasterizer of the same shapes the SVG draws. The SVG stays the
// source of truth; re-run this after any change to it.
//   ./dev-tools/node.sh dev-tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '..', 'web', 'assets', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ---------- PNG encoding ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour + alpha
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- the artwork, in the favicon's 64x64 coordinate space ----------
const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
const INDIGO_A = hex('#8b5cf6');
const INDIGO_B = hex('#5b21b6');
const CREAM = hex('#e9e3fd');
const TEAL = hex('#c4b5fd');
const ROUNDING = 15; // rx of the favicon's rounded square

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}
// M8 40 c9-14 16-14 24 0 c8-14 15-14 24 0 — the two bridge arches, as sampled points
function wavePoints() {
  const pts = [];
  for (const [p0, p1, p2, p3] of [
    [[8, 40], [17, 26], [24, 26], [32, 40]],
    [[32, 40], [40, 26], [47, 26], [56, 40]],
  ]) {
    for (let i = 0; i <= 80; i++) pts.push(cubic(p0, p1, p2, p3, i / 80));
  }
  return pts;
}
const STROKES = [
  { pts: wavePoints(), width: 5, color: CREAM },
  { pts: [[12, 46], [52, 46]], width: 4, color: TEAL },
  { pts: [[20, 46], [20, 38]], width: 3.4, color: TEAL },
  { pts: [[32, 46], [32, 35]], width: 3.4, color: TEAL },
  { pts: [[44, 46], [44, 38]], width: 3.4, color: TEAL },
];

// ---------- rendering ----------
// maskable: full-bleed square with the artwork shrunk into the safe zone, because
// launchers may crop a circle out of any corner. Regular icons keep the favicon's
// rounded square with transparent corners.
function renderIcon(size, { maskable = false, scale = 0.8, ss = 3 } = {}) {
  const dim = size * ss;
  const k = dim / 64;
  const s = maskable ? scale : 1;
  const shrink = ([x, y]) => [32 + (x - 32) * s, 32 + (y - 32) * s];
  const rx = maskable ? 0 : ROUNDING;

  // stroke coverage, stamped into a mask at supersampled resolution; the mask
  // stores which stroke owns the pixel so each keeps its own colour
  const strokeMask = new Uint8Array(dim * dim);
  STROKES.forEach((stroke, index) => {
    const radius = (stroke.width * s * k) / 2;
    const step = radius / 2;
    const pts = stroke.pts.map(shrink).map(([x, y]) => [x * k, y * k]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const length = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(length / step));
      for (let j = 0; j <= n; j++) {
        const cx = ax + ((bx - ax) * j) / n, cy = ay + ((by - ay) * j) / n;
        const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(dim - 1, Math.ceil(cx + radius));
        const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(dim - 1, Math.ceil(cy + radius));
        for (let py = y0; py <= y1; py++) {
          for (let px = x0; px <= x1; px++) {
            const dx = px - cx, dy = py - cy;
            if (dx * dx + dy * dy <= radius * radius) strokeMask[py * dim + px] = index + 1;
          }
        }
      }
    }
  });

  // per supersampled pixel: stroke, else background, else transparent
  const hi = Buffer.alloc(dim * dim * 4);
  for (let py = 0; py < dim; py++) {
    for (let px = 0; px < dim; px++) {
      const o = (py * dim + px) * 4;
      const owner = strokeMask[py * dim + px];
      if (owner) {
        const color = STROKES[owner - 1].color;
        hi[o] = color[0]; hi[o + 1] = color[1]; hi[o + 2] = color[2]; hi[o + 3] = 255;
        continue;
      }
      const x = (px + 0.5) / k, y = (py + 0.5) / k;
      let inside = x >= 0 && x <= 64 && y >= 0 && y <= 64;
      if (inside && rx) {
        const cx = Math.min(Math.max(x, rx), 64 - rx), cy = Math.min(Math.max(y, rx), 64 - rx);
        inside = (x - cx) ** 2 + (y - cy) ** 2 <= rx * rx;
      }
      if (inside) {
        // the SVG's linearGradient from (0,0) to (64,64): t = (x+y)/128
        const t = Math.min(1, Math.max(0, (x + y) / 128));
        for (let c = 0; c < 3; c++) hi[o + c] = Math.round(INDIGO_A[c] + (INDIGO_B[c] - INDIGO_A[c]) * t);
        hi[o + 3] = 255;
      }
    }
  }

  // box downsample in premultiplied space so the rounded corners get clean edges
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const o = ((y * ss + j) * dim + (x * ss + i)) * 4;
          const al = hi[o + 3] / 255;
          r += hi[o] * al; g += hi[o + 1] * al; b += hi[o + 2] * al; a += al;
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return png(size, size, out);
}

const writes = [
  ['icon-192.png', renderIcon(192)],
  ['icon-512.png', renderIcon(512, { ss: 2 })],
  ['icon-maskable-192.png', renderIcon(192, { maskable: true })],
  ['icon-maskable-512.png', renderIcon(512, { maskable: true, ss: 2 })],
  ['apple-touch-icon.png', renderIcon(180, { maskable: true, scale: 0.85 })],
];
for (const [name, bytes] of writes) {
  fs.writeFileSync(path.join(OUT, name), bytes);
  console.log(`wrote web/assets/icons/${name} (${bytes.length} bytes)`);
}
