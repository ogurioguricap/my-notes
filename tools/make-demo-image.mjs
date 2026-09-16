#!/usr/bin/env node
/**
 * 生成演示图片：一张「模型收敛示意图」PNG（零依赖，自写 PNG 编码器）。
 * 用途：验证「图片 → 附件 → 文字进入检索/正文」这条链路。
 * 用法： node tools/make-demo-image.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'content', 'assets', 'demo-convergence.png');

const W = 960;
const H = 560;

// ---------- 画布 ----------
const px = new Float32Array(W * H * 3);
function setPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
}
function fill(r, g, b) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPx(x, y, r, g, b);
}
function rect(x0, y0, w, h, r, g, b) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(x, y, r, g, b);
}
function line(x0, y0, x1, y1, r, g, b, thick = 2) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    for (let dx = 0; dx < thick; dx++) for (let dy = 0; dy < thick; dy++) setPx(x + dx, y + dy, r, g, b);
  }
}
function curve(fn, x0, x1, y0, y1, r, g, b, thick = 3, samples = 600) {
  let prev = null;
  for (let s = 0; s <= samples; s++) {
    const t = s / samples;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * fn(t));
    if (prev) line(prev.x, prev.y, x, y, r, g, b, thick);
    prev = { x, y };
  }
}
function circle(cx, cy, rad, r, g, b) {
  for (let y = -rad; y <= rad; y++) {
    for (let x = -rad; x <= rad; x++) {
      if (x * x + y * y <= rad * rad) setPx(cx + x, cy + y, r, g, b);
    }
  }
}

// ---------- 5x7 位图字体（够画标题与标签） ----------
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '11110', '10001', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};
function text(str, x, y, r, g, b, scale = 3, spacing = 1) {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const glyph = FONT[ch] || FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === '1') rect(cx + col * scale, y + row * scale, scale, scale, r, g, b);
      }
    }
    cx += (5 + spacing) * scale;
  }
  return cx;
}

// ---------- 绘制 ----------
fill(255, 255, 255);
rect(0, 0, W, 74, 24, 30, 44);                        // 标题条
text('MARKOV CHAIN', 28, 18, 255, 255, 255, 4);       // 标题
text('CONVERGENCE', 452, 18, 140, 170, 255, 4);

// 坐标区
const PX0 = 90, PY0 = 120, PX1 = 900, PY1 = 470;
rect(PX0, PY0, PX1 - PX0, PY1 - PY0, 250, 251, 253);
for (let k = 0; k <= 5; k++) {
  const y = Math.round(PY0 + ((PY1 - PY0) * k) / 5);
  line(PX0, y, PX1, y, 228, 231, 236, 1);
}
for (let k = 0; k <= 8; k++) {
  const x = Math.round(PX0 + ((PX1 - PX0) * k) / 8);
  line(x, PY0, x, PY1, 236, 238, 242, 1);
}
line(PX0, PY1, PX1, PY1, 120, 128, 140, 2);
line(PX0, PY0, PX0, PY1, 120, 128, 140, 2);

// 三条概率曲线：从不同初值收敛到各自的平稳分布（单调收敛，和真实迭代一致）
const B = { from: 1.0, to: 0.5521, rate: 2.6 };   // 蓝：下降
const C = { from: 0.0, to: 0.0633, rate: 1.5 };   // 绿：缓升
const A = { from: 0.0, to: 0.3846, rate: 2.0 };   // 橙：升到中间
const curveOf = (p) => (t) => 1 - (p.to - (p.to - p.from) * Math.exp(-p.rate * t));
curve((t) => 1 - curveOf(B)(t), PX0, PX1, PY0, PY1, 59, 110, 245, 4);
curve((t) => 1 - curveOf(C)(t), PX0, PX1, PY0, PY1, 18, 165, 148, 3);
curve((t) => 1 - curveOf(A)(t), PX0, PX1, PY0, PY1, 232, 89, 12, 3);

// 稳态参考线（π_A）
const yPi = Math.round(PY1 - (PY1 - PY0) * A.to);
for (let x = PX0; x < PX1; x += 14) for (let d = 0; d < 6; d++) setPx(x + d, yPi, 190, 198, 210);
circle(PX1 - 4, yPi, 5, 232, 89, 12);

// 图例与标注（颜色与曲线一一对应）
circle(104, 508, 9, 59, 110, 245); text('PI B', 122, 500, 60, 66, 78, 2);
text('=', 196, 500, 120, 128, 140, 2); text('0.5521', 214, 500, 60, 66, 78, 2);
circle(384, 508, 9, 18, 165, 148); text('PI C', 402, 500, 60, 66, 78, 2);
text('=', 476, 500, 120, 128, 140, 2); text('0.0633', 494, 500, 60, 66, 78, 2);
circle(664, 508, 9, 232, 89, 12); text('PI A', 682, 500, 60, 66, 78, 2);
text('=', 756, 500, 120, 128, 140, 2); text('0.3846', 774, 500, 60, 66, 78, 2);
text('STEPS 0-40', 96, 86, 130, 138, 150, 2);
text('P', 30, 288, 130, 138, 150, 2);
text('1.0', 46, 122, 130, 138, 150, 2);
text('0.0', 46, 458, 130, 138, 150, 2);

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 2;   // truecolor RGB
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc((W * 3 + 1) * H);
let o = 0;
for (let y = 0; y < H; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    raw[o++] = px[i];
    raw[o++] = px[i + 1];
    raw[o++] = px[i + 2];
  }
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`✓ 已生成演示图片：${path.relative(ROOT, OUT)}  (${(png.length / 1024).toFixed(1)} KB, ${W}×${H})`);
