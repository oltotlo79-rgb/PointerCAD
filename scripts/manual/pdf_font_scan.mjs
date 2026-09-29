// Same judgment as scripts/manual/font_scan.py (PyMuPDF), written with Node's own zlib and no new dependency, so
// the distribution CI (release.yml, which has no PyMuPDF) can run it right after generate-pdf.mjs and fail the
// job when a PDF falls back to an un-bundled font. Reads the PDFs Chromium (Skia) prints: plain indirect objects,
// Flate content streams, Type3 fonts with ToUnicode maps for the embedded web fonts, and named fonts
// (Type0/TrueType/Type1) for operating-system fonts.
// Usage: node scripts/manual/pdf_font_scan.mjs <pdf-folder> [--bundled <font.otf> ...]
import { Buffer } from 'node:buffer';
import { log } from 'node:console';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { inflateSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../..');

// ---- OpenType cmap (formats 4 and 12) ------------------------------------------------------------------------
function fontCodePoints(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map();
  for (let index = 0, count = view.getUint16(4); index < count; index += 1) {
    const record = 12 + 16 * index;
    tables.set(String.fromCharCode(...bytes.subarray(record, record + 4)), view.getUint32(record + 8));
  }
  const cmap = tables.get('cmap');
  if (cmap === undefined) throw new Error('Font has no cmap');
  const points = new Set();
  for (let index = 0, count = view.getUint16(cmap + 2); index < count; index += 1) {
    const platform = view.getUint16(cmap + 4 + 8 * index), encoding = view.getUint16(cmap + 6 + 8 * index);
    if (!(platform === 3 && (encoding === 1 || encoding === 10)) && platform !== 0) continue;
    const table = cmap + view.getUint32(cmap + 8 + 8 * index), format = view.getUint16(table);
    if (format === 4) {
      const segments = view.getUint16(table + 6) / 2;
      const ends = table + 14, starts = ends + 2 * segments + 2, deltas = starts + 2 * segments, offsets = deltas + 2 * segments;
      for (let segment = 0; segment < segments; segment += 1) {
        const end = view.getUint16(ends + 2 * segment), start = view.getUint16(starts + 2 * segment);
        const delta = view.getInt16(deltas + 2 * segment), rangeOffset = view.getUint16(offsets + 2 * segment);
        for (let code = start; code <= end && code !== 0xffff; code += 1) {
          let glyph;
          if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
          else {
            const at = offsets + 2 * segment + rangeOffset + 2 * (code - start);
            glyph = view.getUint16(at); if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) points.add(code);
        }
      }
    } else if (format === 12) {
      for (let group = 0, groups = view.getUint32(table + 12); group < groups; group += 1) {
        const at = table + 16 + 12 * group, start = view.getUint32(at), end = view.getUint32(at + 4), glyph = view.getUint32(at + 8);
        for (let code = start; code <= end; code += 1) if (glyph + code - start !== 0) points.add(code);
      }
    }
  }
  return points;
}

// ---- PDF objects -----------------------------------------------------------------------------------------------
function parseObjects(pdf) {
  const text = pdf.toString('latin1'), objects = new Map();
  const header = /(\d+) 0 obj\s*/gu;
  for (let match; (match = header.exec(text));) {
    const start = match.index + match[0].length, end = text.indexOf('endobj', start);
    const body = text.slice(start, end), streamAt = body.search(/stream\r?\n/u);
    const dict = streamAt === -1 ? body : body.slice(0, streamAt);
    let stream = null;
    if (streamAt !== -1) {
      const lengthMatch = /\/Length (\d+)(?: 0 R)?/u.exec(dict);
      const dataStart = start + streamAt + (body[streamAt + 6] === '\r' ? 8 : 7);
      const endAt = text.indexOf('endstream', dataStart);
      stream = { dataStart, dataEnd: endAt, lengthRef: lengthMatch && /0 R/u.test(lengthMatch[0]) ? Number(lengthMatch[1]) : null,
        length: lengthMatch && !/0 R/u.test(lengthMatch[0]) ? Number(lengthMatch[1]) : null };
    }
    objects.set(Number(match[1]), { dict, stream });
    header.lastIndex = end;
  }
  const streamBytes = number => {
    const object = objects.get(number);
    if (!object?.stream) throw new Error('Missing stream object ' + number);
    const length = object.stream.length ?? Number(objects.get(object.stream.lengthRef)?.dict.trim());
    const raw = pdf.subarray(object.stream.dataStart, object.stream.dataStart + (Number.isFinite(length) ? length : object.stream.dataEnd - object.stream.dataStart));
    return /\/Filter\s*\/FlateDecode/u.test(object.dict) ? inflateSync(raw) : raw;
  };
  return { objects, streamBytes };
}

const refs = text => [...text.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+) 0 R/gu)].map(match => [match[1], Number(match[2])]);

function subDictionary(dict, key, objects) {
  const at = dict.indexOf('/' + key);
  if (at === -1) return '';
  const rest = dict.slice(at + key.length + 1).trimStart();
  const indirect = /^(\d+) 0 R/u.exec(rest);
  if (indirect) return objects.get(Number(indirect[1]))?.dict ?? '';
  if (!rest.startsWith('<<')) return '';
  let depth = 0;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest.startsWith('<<', index)) { depth += 1; index += 1; }
    else if (rest.startsWith('>>', index)) { depth -= 1; index += 1; if (depth === 0) return rest.slice(0, index + 1); }
  }
  throw new Error('Unterminated dictionary: ' + key);
}

function toUnicodeMap(bytes) {
  const text = bytes.toString('latin1'), map = new Map();
  const utf16 = hex => { const units = []; for (let i = 0; i < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16)); return String.fromCharCode(...units); };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/gu)) map.set(parseInt(pair[1], 16), utf16(pair[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    for (const range of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/gu)) {
      const low = parseInt(range[1], 16), high = parseInt(range[2], 16);
      if (range[3].startsWith('[')) {
        [...range[3].matchAll(/<([0-9A-Fa-f]+)>/gu)].forEach((entry, offset) => map.set(low + offset, utf16(entry[1])));
      } else {
        const base = range[3].slice(1, -1);
        for (let code = low; code <= high; code += 1) {
          const last = parseInt(base.slice(-4), 16) + code - low;
          map.set(code, utf16(base.slice(0, -4) + last.toString(16).padStart(4, '0')));
        }
      }
    }
  }
  return map;
}

// ---- Content streams: which font draws which characters ---------------------------------------------------------
function* textShows(content) {
  const text = content.toString('latin1');
  const stack = [];
  let index = 0;
  const readString = () => {
    let depth = 1, out = [];
    index += 1;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (char === '\\') {
        const next = text[index + 1];
        const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
        if (next in escapes) { out.push(escapes[next]); index += 2; continue; }
        const octal = /^[0-7]{1,3}/u.exec(text.slice(index + 1, index + 4));
        if (octal) { out.push(parseInt(octal[0], 8) & 0xff); index += 1 + octal[0].length; continue; }
        index += 2; continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') { depth -= 1; if (depth === 0) { index += 1; break; } }
      out.push(char.charCodeAt(0)); index += 1;
    }
    return Buffer.from(out);
  };
  while (index < text.length) {
    const char = text[index];
    if (/\s/u.test(char)) { index += 1; continue; }
    if (char === '%') { while (index < text.length && text[index] !== '\n') index += 1; continue; }
    if (char === '(') { stack.push({ string: readString() }); continue; }
    if (char === '<' && text[index + 1] !== '<') {
      const end = text.indexOf('>', index);
      const hex = text.slice(index + 1, end).replace(/\s/gu, '');
      stack.push({ string: Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex') }); index = end + 1; continue;
    }
    if (char === '[' || char === ']' || (char === '<' && text[index + 1] === '<') || (char === '>' && text[index + 1] === '>')) {
      stack.push({ mark: char }); index += char === '[' || char === ']' ? 1 : 2; continue;
    }
    const token = /^[^\s()<>[\]{}/%]+|^\/[^\s()<>[\]{}/%]*/u.exec(text.slice(index, index + 256))[0];
    index += token.length;
    if (token.startsWith('/')) { stack.push({ name: token.slice(1) }); continue; }
    if (/^[-+.\d]/u.test(token)) { stack.push({ number: Number(token) }); continue; }
    // operator
    if (token === 'Tf') yield { font: stack[stack.length - 2]?.name };
    else if (token === 'Tj' || token === "'") yield { strings: [stack[stack.length - 1]?.string].filter(Boolean) };
    else if (token === '"') yield { strings: [stack[stack.length - 1]?.string].filter(Boolean) };
    else if (token === 'TJ') {
      const open = stack.map(entry => entry.mark).lastIndexOf('[');
      yield { strings: stack.slice(open + 1).map(entry => entry.string).filter(Boolean) };
    }
    stack.length = 0;
  }
}

export function scanPdf(pdf, covered) {
  const { objects, streamBytes } = parseObjects(pdf);
  const fontInfo = new Map();
  const describeFont = number => {
    if (fontInfo.has(number)) return fontInfo.get(number);
    const dict = objects.get(number)?.dict ?? '';
    const subtype = /\/Subtype\s*\/(\w+)/u.exec(dict)?.[1] ?? 'Unknown';
    const baseFont = /\/BaseFont\s*\/([^\s/<>[\]]+)/u.exec(dict)?.[1] ?? null;
    const toUnicode = /\/ToUnicode (\d+) 0 R/u.exec(dict);
    const info = { subtype, name: baseFont === null ? null : baseFont.replace(/^[A-Z]{6}\+/u, ''),
      bytesPerCode: subtype === 'Type0' ? 2 : 1, map: toUnicode ? toUnicodeMap(streamBytes(Number(toUnicode[1]))) : new Map() };
    fontInfo.set(number, info); return info;
  };
  const offenders = new Map(), pages = [];
  for (const [number, object] of objects) if (/\/Type\s*\/Page(?![s\w])/u.test(object.dict)) pages.push(number);
  pages.sort((a, b) => a - b);
  for (const [pageIndex, number] of pages.entries()) {
    const dict = objects.get(number).dict;
    const fonts = new Map(refs(subDictionary(subDictionary(dict, 'Resources', objects), 'Font', objects)));
    const contents = /\/Contents\s*\[([^\]]*)\]/u.exec(dict)?.[1] ?? /\/Contents\s*(\d+ 0 R)/u.exec(dict)?.[1] ?? '';
    const streams = [...contents.matchAll(/(\d+) 0 R/gu)].map(match => streamBytes(Number(match[1])));
    let current = null;
    for (const content of streams) {
      for (const event of textShows(content)) {
        if (event.font !== undefined) { current = fonts.has(event.font) ? describeFont(fonts.get(event.font)) : null; continue; }
        if (!current) continue;
        const chars = [];
        for (const string of event.strings) {
          for (let at = 0; at + current.bytesPerCode <= string.length; at += current.bytesPerCode) {
            const code = current.bytesPerCode === 2 ? string.readUInt16BE(at) : string[at];
            for (const char of current.map.get(code) ?? '') if (char.trim()) chars.push(char);
          }
        }
        if (chars.length === 0) continue;
        let key = null, drawn = chars;
        if (current.name === null) {
          drawn = chars.filter(char => !covered(char));
          if (drawn.length) key = 'Type3（同梱の字体に無い文字）';
        } else key = `${current.name}（同梱でない名前付きの字体）`;
        if (!key) continue;
        const entry = offenders.get(key) ?? { pages: new Set(), chars: new Set() };
        entry.pages.add(pageIndex + 1); for (const char of drawn) entry.chars.add(char);
        offenders.set(key, entry);
      }
    }
  }
  return { pages: pages.length, offenders };
}

if (import.meta.url === `file:///${argv[1].replaceAll('\\', '/')}` || argv[1]?.endsWith('pdf_font_scan.mjs')) {
  const args = argv.slice(2);
  const folder = args[0];
  const bundledFiles = [];
  for (let index = 1; index < args.length; index += 1) if (args[index] === '--bundled') bundledFiles.push(args[++index]);
  if (bundledFiles.length === 0) {
    const record = JSON.parse(readFileSync(join(root, 'scripts/manual/fonts/font-notices.json'), 'utf8'));
    bundledFiles.push(join(root, 'apps/web/public/fonts/NotoSansJP-Regular.otf'), ...record.fonts.map(font => join(root, 'scripts/manual/fonts', font.file)));
  }
  const points = bundledFiles.map(file => fontCodePoints(readFileSync(file)));
  const has = char => points.some(set => set.has(char.codePointAt(0)));
  const covered = char => has(char) || (() => { const parts = [...char.normalize('NFD')]; return parts.length > 1 && parts.every(has); })();
  const pdfs = readdirSync(folder).filter(name => name.endsWith('.pdf')).sort();
  if (pdfs.length === 0) { log('FAIL: PDF がありません:', folder); exit(2); }
  let total = 0;
  for (const name of pdfs) {
    const { pages, offenders } = scanPdf(readFileSync(join(folder, name)), covered);
    log(name, pages, 'pages');
    for (const [key, entry] of [...offenders].sort()) {
      const list = [...entry.pages].sort((a, b) => a - b);
      log(`  非同梱: ${key} ${list.length} ページ [${list.slice(0, 15).join(', ')}${list.length > 15 ? ' …' : ''}] 文字: ${[...entry.chars].sort().join('').slice(0, 80)}`);
    }
    total += offenders.size;
  }
  if (total) { log(`FAIL: 非同梱の字体が ${total} 件（巻ごとの字体の数の合計）`); exit(1); }
  log(`PASS: 全${pdfs.length}巻の全ページで非同梱の字体の一覧は空`);
}
