#!/usr/bin/env node
// Generates the toolbar icons and the surrogate resources in src/.
// Run once (outputs are checked in): node tools/make-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Icon: a rounded square in deep teal with a light ring and a short bar,
// i.e. a "mute" mark. Rendered with 8x8 supersampling.
function icon(size) {
  const S = 8, out = Buffer.alloc(size * size * 4);
  const bg = [0x2f, 0x4f, 0x4d], fg = [0xee, 0xf2, 0xf1];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, f = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
      const r = 0.22, dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0), dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
      if (dx * dx + dy * dy > r * r) continue;
      a++;
      const d = Math.hypot(u - 0.5, v - 0.5);
      const ring = d > 0.24 && d < 0.33;
      const bar = Math.abs(v - 0.5) < 0.055 && Math.abs(u - 0.5) < 0.15;
      if (ring || bar) f++;
    }
    const i = (y * size + x) * 4, t = a ? f / a : 0;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(bg[c] * (1 - t) + fg[c] * t);
    out[i + 3] = Math.round((a / (S * S)) * 255);
  }
  return png(size, out);
}

const iconDir = path.join(ROOT, 'src', 'icons');
fs.mkdirSync(iconDir, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(iconDir, `icon${s}.png`), icon(s));

const war = path.join(ROOT, 'src', 'web_accessible_resources');
fs.mkdirSync(war, { recursive: true });
fs.writeFileSync(path.join(war, 'noop.js'), '(function(){})();\n');
fs.writeFileSync(path.join(war, 'noop.txt'), '');
fs.writeFileSync(path.join(war, 'noop.css'), '');
fs.writeFileSync(path.join(war, 'noop.json'), '{}');
fs.writeFileSync(path.join(war, 'noop.html'), '<!doctype html><html><head></head><body></body></html>\n');
fs.writeFileSync(path.join(war, '1x1.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
fs.writeFileSync(path.join(war, '2x2.png'), png(2, Buffer.alloc(16)));
console.log('icons and surrogate resources written');
