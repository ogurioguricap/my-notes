#!/usr/bin/env node
/**
 * 附件文字提取：把图片 / PDF / 文本附件里的文字抓出来，写进 content/_extracted.json
 * 构建脚本（tools/build.mjs）会读取这个文件，把文字：
 *   1) 拼进笔记正文末尾的「附件文字」区块
 *   2) 写进搜索索引 → 于是搜索框能搜到图片里的字
 *
 * 零依赖用法（本机可跑）： node tools/extract-attachments.mjs
 * ├─ PDF：内置极简解析器（解压 FlateDecode 流 + 抽取文本算子），对本机生成的 PDF 有效；
 * │        复杂 PDF（扫描件、CID 字体）请只放置占位条目，或接入外部 OCR。
 * └─ 图片：PNG/JPEG 无法在无依赖前提下可靠 OCR，脚本会：
 *        · 复用 content/_extracted.json 里已有的人工/外部 OCR 文本
 *        · 标记 needs-ocr: true，提示「这条等你补文字」
 *
 * 进阶（可选，联网时）：安装 OCR 后自行接入，例如
 *        npm i tesseract.js           → 中文包 chi_sim
 *        npm i pdf-parse              → 直接抽 PDF 文本
 * 提取结果格式：
 *   { "assets/demo-convergence.png": { "source": "ocr-manual", "text": "..." } }
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content');
const ASSETS = path.join(CONTENT, 'assets');
const OUT = path.join(CONTENT, '_extracted.json');

const IMG = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const PDF = /\.pdf$/i;
const TXT = /\.(txt|md|csv|json|srt|log)$/i;

function walk(dir, base = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/** 极简 PDF 文本抽取：遍历所有 FlateDecode 流，抓 Tj / TJ 里的字符串 */
function pdfText(buf) {
  const chunks = [];
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let i = 0;
  while (i < buf.length) {
    const s = buf.indexOf(marker, i);
    if (s === -1) break;
    let start = s + marker.length;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf(endMarker, start);
    if (e === -1) break;
    const rawStream = buf.subarray(start, e);
    let text = null;
    try {
      text = zlib.inflateSync(rawStream).toString('latin1');
    } catch (err) {
      text = rawStream.toString('latin1');
    }
    // 抽取 (...)Tj 与 [...]TJ
    const re = /\((?:\\.|[^\\()])*\)/g;
    let m;
    const found = [];
    while ((m = re.exec(text))) found.push(m[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
    if (found.length) chunks.push(found.join(''));
    i = e + endMarker.length;
  }
  return chunks.join('\n').replace(/\s{3,}/g, ' ').trim();
}

export function main() {
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const files = walk(ASSETS);
  // 归一化已有条目的键：统一成 "assets/xxx"
  const pre = {};
  for (const [k, v] of Object.entries(existing)) {
    const key = k.startsWith('assets/') ? k : `assets/${k}`;
    const prev = pre[key];
    if (!prev || (!(prev.text || '').trim() && (v.text || '').trim())) pre[key] = v;
    else if (!prev) pre[key] = v;
  }
  const result = { ...pre };
  let added = 0;
  let pending = 0;

  for (const rel of files) {
    const key = `assets/${rel.replace(/^assets\//, '')}`;
    if (IMG.test(rel)) {
      if (!result[key] || !(result[key].text || '').trim()) {
        result[key] = { ...(result[key] || {}), source: (result[key] && result[key].source) || 'pending-ocr', text: (result[key] && result[key].text) || '', note: '图片未提取文字：请补 OCR 文本（写进 content/_extracted.json 的 text 字段），补完即可被搜索命中' };
        pending++;
      }
    } else if (PDF.test(rel)) {
      const buf = fs.readFileSync(path.join(ASSETS, rel));
      const text = pdfText(buf);
      if (text && text.length > 20) {
        result[key] = { source: 'pdf-builtin', text };
        added++;
      } else if (!(result[key] && result[key].text)) {
        result[key] = { source: 'pending-ocr', text: '', note: 'PDF 未抽出文本（可能是扫描件），需要 OCR' };
        pending++;
      }
    } else if (TXT.test(rel)) {
      const text = fs.readFileSync(path.join(ASSETS, rel), 'utf8');
      result[key] = { source: 'plain-text', text };
      added++;
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  const withText = Object.values(result).filter((v) => (v.text || '').trim()).length;
  console.log(`✓ 附件文字提取完成：${files.length} 个附件，其中 ${withText} 个已有文字，${pending} 个待补 OCR`);
  console.log(`  ${path.relative(ROOT, OUT)}`);
  console.log('  → 再执行 node tools/build.mjs，这些文字就会进入正文与检索索引');
  return true;
}

const isDirect = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) main();
