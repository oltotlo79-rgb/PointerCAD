import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { installedRuntimeDependencies, verifyRuntimeDependencyInventory } from './runtimeDependencyInventory.mjs';
import { collectScriptRuntimeNotices } from './scriptRuntimeNotices.mjs';

const rootFolder = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function collectRuntimeNotices(root = rootFolder) {
  const actual = installedRuntimeDependencies(root), folder = join(root, 'docs/standards/licenses');
  const source = readFileSync(join(folder, 'runtime-notices.json'));
  const manifest = JSON.parse(source.toString('utf8'));
  if (manifest.format !== 'pointercad-runtime-notices/1' || !Array.isArray(manifest.packages)) throw new Error('Invalid runtime notice manifest');
  verifyRuntimeDependencyInventory(actual, manifest.packages);
  const assets = collectScriptRuntimeNotices(root), unresolved = [], links = [];
  for (const item of manifest.packages) {
    const installed = actual.find(candidate => candidate.name === item.name && candidate.version === item.version);
    const title = escape(item.name + ' ' + item.version + ' (' + item.license + ')');
    if (item.status === 'unresolved' && typeof item.reason === 'string' && item.reason.length > 0 && item.notices.length === 0) {
      unresolved.push(item.name + '@' + item.version);
      links.push('<li>' + title + ' — 原文未取得: ' + escape(item.reason) + '</li>');
      continue;
    }
    if (item.status !== 'verified' || !Array.isArray(item.notices) || item.notices.length === 0) throw new Error('Missing runtime notice status');
    const filenames = new Set();
    for (const notice of item.notices) {
      if (!/^[a-z0-9.-]+\.txt$/u.test(notice.file) || notice.file.includes('..')
        || !/^[A-Za-z0-9._-]+$/u.test(notice.installedFile) || notice.installedFile.includes('..')
        || filenames.has(notice.installedFile) || !/^[a-f0-9]{64}$/u.test(notice.sha256)) throw new Error('Invalid runtime notice path or digest');
      filenames.add(notice.installedFile);
      const bytes = readFileSync(join(folder, notice.file));
      if (sha(bytes) !== notice.sha256) throw new Error('Runtime notice changed: ' + notice.file);
      for (const dependency of installed.folders) {
        if (!bytes.equals(readFileSync(join(dependency, notice.installedFile)))) throw new Error('Installed runtime notice changed: ' + item.name);
      }
      const path = 'licenses/runtime/' + notice.file;
      if (assets.has(path) && !assets.get(path).equals(bytes)) throw new Error('Runtime notice path collision');
      assets.set(path, bytes);
      links.push('<li>' + title + ': <a href="./' + notice.file + '">' + notice.file + '</a></li>');
    }
  }
  assets.set('licenses/runtime/runtime-notices.json', source);
  assets.set('licenses/runtime/index.html', Buffer.from('<!doctype html><html lang="ja"><meta charset="utf-8">' +
    '<title>PointerCAD 利用部品の著作権・許諾表示</title><h1>利用部品の著作権・許諾表示</h1>' +
    '<p>各部品の許諾はそれぞれの原文に従います。</p><ul>' + links.join('\n') + '</ul>' +
    '<p><a href="../index.html">数学入力と字体</a> / <a href="../exact-math/">追加計算部</a> / <a href="../script-runtime/">自動作図の実行部</a> / ' +
    '<a href="../../fonts/LICENSES.txt">画面と図面の字体</a></p></html>', 'utf8'));
  assets.set('LICENSE', readFileSync(join(root, 'LICENSE')));
  assets.set('NOTICE', readFileSync(join(root, 'NOTICE')));
  return { assets, unresolved };
}

/** Missing upstream originals remain visible; final publication checks must reject them. */
export function assertRuntimeNoticesPublishable(distribution) {
  if (distribution.unresolved.length !== 0) throw new Error('Unresolved runtime notices: ' + distribution.unresolved.join(', '));
}

export function runtimeNotices() {
  return { name: 'pointercad-runtime-notices', apply: 'build', buildStart() {
    for (const [fileName, source] of collectRuntimeNotices().assets) this.emitFile({ type: 'asset', fileName, source });
  } };
}
