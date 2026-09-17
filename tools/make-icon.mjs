#!/usr/bin/env node
/**
 * 把一张竖图裁成正方形并做成多尺寸 ICO（用于 Windows 快捷方式图标）+ 网页图标
 * 零依赖：自解 PNG（含全部 5 种 filter）、自写缩放、自写 ICO 与 PNG 编码。
 *
 * 用法：
 *   node tools/make-icon.mjs                           使用默认源图
 *   node tools/make-icon.mjs --crop 0.32               调整纵向裁剪位置（0=最上，1=最下）
 *   node tools/make-icon.mjs --src 路径\图.jpg          指定源图（会调用 Windows 自带解码）
 *
 * 产物：
 *   docs/icon.png / icon-192.png / icon-512.png / apple-touch-icon.png / favicon.ico
 *   我的笔记.ico                     桌面快捷方式图标（16~256 多尺寸）
 *   content/assets/brand-icon.jpg    原图留档
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SRC = 'C:\\Users\\17264\\OneDrive\\桌面\\动漫图片合集\\oguri.jpg';
const CROP = (() => {
  const i = process.argv.indexOf('--crop');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 0.32;
})();
const SRC = (() => {
  const i = process.argv.indexOf('--src');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : DEFAULT_SRC;
})();

/* ============================ PNG 解码 ============================ */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let i = 8;
  let w = 0, h = 0, bitDepth = 8, colorType = 6, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8).toString('ascii');
    const data = buf.slice(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (interlace) throw new Error('不支持隔行 PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的 colorType: ' + colorType);
  if (bitDepth !== 8) throw new Error('仅支持 8 位深度，实为 ' + bitDepth);

  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride);
    pos += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }

  // 统一转成 RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    let r = 0, g = 0, b = 0, al = 255;
    if (colorType === 6) { r = out[p * 4]; g = out[p * 4 + 1]; b = out[p * 4 + 2]; al = out[p * 4 + 3]; }
    else if (colorType === 2) { r = out[p * 3]; g = out[p * 3 + 1]; b = out[p * 3 + 2]; }
    else if (colorType === 0) { r = g = b = out[p]; }
    else if (colorType === 4) { r = g = b = out[p * 2]; al = out[p * 2 + 1]; }
    else if (colorType === 3) {
      const idx = out[p];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) al = trns[idx];
    }
    rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; rgba[p * 4 + 3] = al;
  }
  return { width: w, height: h, rgba };
}

/* ============================ 缩放（盒子滤波，带 alpha 加权） ============================ */
function resize(src, size) {
  if (src.width === size && src.height === size) return Buffer.from(src.rgba);
  const out = Buffer.alloc(size * size * 4);
  const sx = src.width / size, sy = src.height / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(src.height, Math.ceil((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(src.width, Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * src.width + xx) * 4;
          const al = src.rgba[p + 3] / 255;
          r += src.rgba[p] * al; g += src.rgba[p + 1] * al; b += src.rgba[p + 2] * al;
          a += al; n++;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / Math.max(1, n)) * 255);
    }
  }
  return out;
}

/* ============================ PNG 编码 ============================ */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    rgba.copy(raw, o, y * w * 4, (y + 1) * w * 4);
    o += w * 4;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ============================ 圆角（图标更好看） ============================ */
function roundCorners(rgba, size, radiusRatio = 0.22) {
  const r = size * radiusRatio;
  const out = Buffer.from(rgba);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = true;
      const cx = x < r ? r - x : x > size - r - 1 ? x - (size - r - 1) : 0;
      const cy = y < r ? r - y : y > size - r - 1 ? y - (size - r - 1) : 0;
      if (cx > 0 && cy > 0) {
        const d = Math.hypot(cx, cy);
        if (d > r) inside = false;
        else if (d > r - 1.2) {
          const p = (y * size + x) * 4;
          out[p + 3] = Math.round(out[p + 3] * (r - d));
        }
      }
      if (!inside) out[(y * size + x) * 4 + 3] = 0;
    }
  }
  return out;
}

/* ============================ ICO 封装 ============================ */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  entries.forEach((e, i) => {
    const b = i * 16;
    dir[b] = e.size >= 256 ? 0 : e.size;          // 宽（256 记为 0）
    dir[b + 1] = e.size >= 256 ? 0 : e.size;      // 高
    dir[b + 2] = 0;                               // 调色板数
    dir[b + 3] = 0;                               // reserved
    dir.writeUInt16LE(1, b + 4);                  // 颜色平面
    dir.writeUInt16LE(32, b + 6);                 // 位深
    dir.writeUInt32BE(0, b + 8);
    dir.writeUInt32LE(e.data.length, b + 8);      // 数据长度
    dir.writeUInt32LE(offset, b + 12);            // 数据偏移
    offset += e.data.length;
    blobs.push(e.data);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

/* ============================ 主流程 ============================ */
/** 用 Windows 自带解码器把任意图片解码成正方形 PNG（base64），零外部依赖 */
function decodeWithWindows(srcPath, crop = CROP) {
  const tmp = path.join(ROOT, '_icon_pixels.txt');
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile("${srcPath}")
$side = [Math]::Min($img.Width, $img.Height)
$x = [int](($img.Width - $side) / 2)
$y = [int](($img.Height - $side) * ${crop})
$bmp = New-Object System.Drawing.Bitmap($side, $side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, (New-Object System.Drawing.Rectangle(0,0,$side,$side)), (New-Object System.Drawing.Rectangle($x,$y,$side,$side)), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$b64 = [Convert]::ToBase64String($ms.ToArray())
$sb = New-Object System.Text.StringBuilder
for ($i = 0; $i -lt $b64.Length; $i += 200) {
  $len = [Math]::Min(200, $b64.Length - $i)
  [void]$sb.AppendLine($b64.Substring($i, $len))
}
[System.IO.File]::WriteAllText("${tmp}", $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
$ms.Dispose(); $bmp.Dispose(); $img.Dispose()
Write-Output "$side"
`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    throw new Error('Windows 解码失败：' + (r.stderr || r.stdout || '').slice(0, 200));
  }
  const side = parseInt(String(r.stdout).trim().split(/\s+/).pop(), 10) || 0;
  return { b64: fs.readFileSync(tmp, 'utf8').replace(/\s+/g, ''), side, tmp };
}

export function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--') && (a.endsWith('.txt') || a.endsWith('.png')));
  let image;
  let cleanup = null;

  if (arg) {
    const srcPath = path.resolve(ROOT, arg);
    if (!fs.existsSync(srcPath)) { console.error(`✗ 找不到：${srcPath}`); return false; }
    image = /\.png$/i.test(arg)
      ? decodePng(fs.readFileSync(srcPath))
      : decodePng(Buffer.from(fs.readFileSync(srcPath, 'utf8').replace(/\s+/g, ''), 'base64'));
  } else if (fs.existsSync(SRC)) {
    const { b64, side, tmp } = decodeWithWindows(SRC, CROP);
    image = decodePng(Buffer.from(b64, 'base64'));
    cleanup = tmp;
    console.log(`✓ 用 Windows 解码源图：${image.width}×${image.height}（裁剪比例 ${CROP}）`);
  } else {
    console.error(`✗ 找不到源图：${SRC}\n  可用 --src 指定，或先把图片解码成 PNG 再传入`);
    return false;
  }
  console.log(`✓ 源图就绪：${image.width}×${image.height}`);

  const DOCS = path.join(ROOT, 'docs');
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const icoEntries = sizes.map((s) => {
    const px = roundCorners(resize(image, s), s, s <= 32 ? 0.16 : 0.22);
    return { size: s, data: encodePng(px, s, s) };
  });
  const ico = buildIco(icoEntries);

  const icRn = path.join(ROOT, '我的笔记.ico');
  fs.writeFileSync(icRn, ico);
  fs.writeFileSync(path.join(DOCS, 'favicon.ico'), ico);

  // 网页用的大图
  const big = roundCorners(resize(image, 512), 512, 0.22);
  fs.writeFileSync(path.join(DOCS, 'icon-512.png'), encodePng(big, 512, 512));
  const mid = roundCorners(resize(image, 192), 192, 0.22);
  fs.writeFileSync(path.join(DOCS, 'icon-192.png'), encodePng(mid, 192, 192));
  const touch = roundCorners(resize(image, 180), 180, 0.2);
  fs.writeFileSync(path.join(DOCS, 'apple-touch-icon.png'), encodePng(touch, 180, 180));
  fs.writeFileSync(path.join(DOCS, 'icon.png'), encodePng(big, 512, 512));

  // 原始素材存一份（方便以后重做）
  const assets = path.join(ROOT, 'content', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  if (fs.existsSync(SRC)) fs.copyFileSync(SRC, path.join(assets, 'brand-icon.jpg'));
  if (cleanup && fs.existsSync(cleanup)) fs.unlinkSync(cleanup);

  console.log(`✓ ICO：我的笔记.ico（${sizes.join('/')} 共 ${(ico.length / 1024).toFixed(1)} KB）`);
  console.log('✓ 网页图标：docs/favicon.ico · icon-192.png · icon-512.png · apple-touch-icon.png');
  console.log('✓ 原图已存 content/assets/brand-icon.jpg');
  return true;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const ok = main();
  if (!ok) process.exitCode = 1;
}
