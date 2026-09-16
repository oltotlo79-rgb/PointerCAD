import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const rootFolder = fileURLToPath(new URL('../../vendor/exact-math/', import.meta.url));
const sourcePartBytes = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = value => typeof value === 'string' && /^[A-Za-z0-9._/-]+$/u.test(value)
  && !value.split('/').some(part => part === '' || part === '.' || part === '..');
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Verify every pinned input before creating output. Source archives are split losslessly for Pages. */
export function buildExactMathAssets(manifest, files) {
  if (!record(manifest) || manifest.format !== 'pointercad-exact-runtime/1'
    || !record(manifest.files) || !record(manifest.components)) throw new Error('Invalid exact runtime inventory');
  const names = Object.keys(manifest.files);
  if (names.length === 0 || names.length !== files.size || names.some(name => !files.has(name))) {
    throw new Error('Exact runtime file inventory changed');
  }
  const folded = new Set();
  for (const name of names) {
    const pin = manifest.files[name], bytes = files.get(name);
    if (!safePath(name) || !/^(runtime|notices|sources|evidence)\//u.test(name)
      || folded.has(name.toLowerCase()) || !record(pin) || !Buffer.isBuffer(bytes)
      || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0 || pin.bytes > 100 * 1024 * 1024
      || bytes.byteLength !== pin.bytes || !/^[a-f0-9]{64}$/u.test(pin.sha256)
      || hash(bytes) !== pin.sha256) throw new Error(`Exact runtime input changed: ${name}`);
    folded.add(name.toLowerCase());
  }
  for (const [component, notices] of Object.entries(manifest.components)) {
    if (component.length === 0 || !Array.isArray(notices) || notices.length === 0
      || notices.some(name => !safePath(name) || name.includes('/') || !files.has(`notices/${name}`))) {
      throw new Error('Exact runtime component notice is missing');
    }
  }
  const assets = new Map(), distributions = {};
  const addAsset = (name, bytes) => {
    if (assets.has(name)) throw new Error(`Exact runtime output collision: ${name}`);
    assets.set(name, bytes);
  };
  for (const name of names.sort()) {
    const bytes = files.get(name);
    const output = name.startsWith('runtime/') ? `exact-math/${name}` : `licenses/exact-math/${name}`;
    if (bytes.byteLength > sourcePartBytes && !name.startsWith('sources/')) {
      throw new Error(`Exact runtime asset exceeds the distribution bound: ${name}`);
    }
    const parts = [];
    for (let start = 0; start < bytes.byteLength; start += sourcePartBytes) {
      const part = bytes.subarray(start, Math.min(start + sourcePartBytes, bytes.byteLength));
      const file = bytes.byteLength <= sourcePartBytes ? output : `${output}.part-${String(parts.length + 1).padStart(3, '0')}`;
      addAsset(file, part);
      parts.push({ file, bytes: part.byteLength, sha256: hash(part) });
    }
    distributions[name] = { ...manifest.files[name], parts };
  }
  const shipped = { ...manifest, files: distributions };
  assets.set('licenses/exact-math/manifest.json', Buffer.from(JSON.stringify(shipped, null, 2) + '\n'));
  const entries = names.filter(name => !name.startsWith('runtime/')).map(name => {
    const links = distributions[name].parts.map(part =>
      `<a href="./${part.file.slice('licenses/exact-math/'.length)}">${escape(part.file.split('/').at(-1))}</a>`).join(' / ');
    return `<li>${escape(name)}: ${links}</li>`;
  }).join('\n');
  const components = Object.entries(manifest.components).map(([name, notices]) =>
    `<li>${escape(name)}: ${notices.map(notice => `<a href="./notices/${notice}">${notice}</a>`).join(' / ')}</li>`).join('\n');
  assets.set('licenses/exact-math/index.html', Buffer.from('<!doctype html><html lang="ja"><meta charset="utf-8">'
    + '<title>追加計算部の許諾原文とソース</title><h1>追加計算部の許諾原文とソース</h1>'
    + '<p>Pyodide／SymPy／mpmathと関連部品の原文です。各部品の条件は下記の原文を参照してください。</p>'
    + `<ul>${components}</ul><h2>配布した原文・対応資料・ソース</h2><ul>${entries}</ul>`
    + '<p>大きなソース書庫は内容を変えずに分割しています。part-001、part-002の順にバイナリ連結すると元の書庫に戻ります。'
    + '元の名前・サイズ・SHA-256と各分割ファイルの順序は<a href="./manifest.json">一覧</a>に記載しています。</p></html>'));
  return assets;
}

/** Read from this repository only; junctions, omissions and unrecorded additions fail closed. */
export function collectExactMathAssets(folder = rootFolder) {
  const base = realpathSync(folder), files = new Map();
  function walk(directory, prefix) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), local = prefix + name, stat = lstatSync(path);
      const resolved = relative(base, realpathSync(path));
      if (stat.isSymbolicLink() || resolved.startsWith('..') || isAbsolute(resolved)) {
        throw new Error('Exact runtime input escapes its folder');
      }
      if (stat.isDirectory()) walk(path, local + '/');
      else if (!stat.isFile()) throw new Error('Exact runtime input is not a regular file');
      else if (!['manifest.json', 'README.md', '.gitattributes'].includes(local)) files.set(local, readFileSync(path));
    }
  }
  walk(base, '');
  return buildExactMathAssets(JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8')), files);
}

export function exactMathAssets() {
  let building = true, base = '/';
  return {
    name: 'pointercad-exact-math-assets',
    configResolved(config) {
      building = config.command === 'build';
      base = new URL(config.base, 'http://pointercad.invalid/').pathname;
    },
    configureServer(server) {
      const runtime = new Map([...collectExactMathAssets()].filter(([name]) => name.startsWith('exact-math/runtime/')));
      const prefix = base + 'exact-math/runtime/';
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://pointercad.invalid');
        if (!url.pathname.startsWith(prefix)) { next(); return; }
        const file = url.pathname.slice(base.length), bytes = runtime.get(file);
        if (url.search !== '' || bytes === undefined) { response.statusCode = 404; response.end(); return; }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405; response.end(); return;
        }
        response.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript'
          : file.endsWith('.json') ? 'application/json' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        response.setHeader('Content-Length', String(bytes.byteLength));
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        response.end(request.method === 'HEAD' ? undefined : bytes);
      });
    },
    buildStart() {
      if (!building) return;
      for (const [fileName, source] of collectExactMathAssets()) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
