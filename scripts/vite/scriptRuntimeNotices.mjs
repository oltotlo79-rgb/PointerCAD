import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = bytes => bytes.toString('utf8').replace(/\r\n/gu, '\n');
const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Verify the native artifact as well as npm's graph; removing an npm name alone is insufficient. */
export function collectScriptRuntimeNotices(root) {
  const vendor = join(root, 'packages/model/src/vendor/script-runtime'), licenses = join(root, 'docs/standards/licenses');
  const manifest = JSON.parse(readFileSync(join(vendor, 'manifest.json'), 'utf8'));
  const config = JSON.parse(readFileSync(join(vendor, 'build-config.json'), 'utf8'));
  const binary = readFileSync(join(vendor, 'quickjs-pcad.wasm'));
  if (manifest.bridge !== 'pcad-interface.c' || manifest.bridgeAbi !== 1 || manifest.wrapperRevision !== undefined
    || config.inputs.length !== 3 || config.inputs.some(item => !['wasi-sysroot-32.0.tar.gz', 'libclang_rt-32.0.tar.gz', 'quickjs-ng-source.tar.gz'].includes(item.name))
    || JSON.stringify(config).includes('quickjs-wasi') || config.flags.includes('c/interface.c')) throw new Error('Unreviewed script runtime build source');
  if (sha(binary) !== manifest.sha256 || binary.length !== manifest.bytes) throw new Error('Script runtime binary changed');
  if (sha(normalized(readFileSync(join(vendor, manifest.bridge)))) !== config.bridgeSha256
    || manifest.bridgeSha256 !== config.bridgeSha256
    || sha(normalized(readFileSync(join(vendor, 'resource-limits.patch')))) !== config.patchSha256) throw new Error('Script runtime source changed');
  const module = new globalThis.WebAssembly.Module(binary);
  const exports = globalThis.WebAssembly.Module.exports(module).map(item => item.name);
  for (const name of ['pcad_abi', 'pcad_init', 'pointercad_resource_failure', 'pointercad_resource_line', 'pointercad_resource_column', 'pointercad_resource_file_byte']) {
    if (!exports.includes(name)) throw new Error('Script runtime boundary is missing: ' + name);
  }
  const data = readFileSync(join(licenses, 'script-runtime-notices.json'));
  const notices = JSON.parse(data.toString('utf8'));
  if (notices.format !== 'pointercad-script-runtime-notices/1' || !Array.isArray(notices.notices) || notices.notices.length !== 12) {
    throw new Error('Script runtime notices are incomplete');
  }
  const assets = new Map(), links = [];
  for (const notice of notices.notices) {
    if (!/^[a-z0-9-]+\.txt$/u.test(notice.file) || !/^[a-f0-9]{64}$/u.test(notice.sha256)
      || !notice.url.startsWith('https://raw.githubusercontent.com/')) throw new Error('Invalid script runtime notice');
    const name = 'licenses/script-runtime/' + notice.file, bytes = readFileSync(join(licenses, notice.file));
    if (assets.has(name) || sha(bytes) !== notice.sha256) throw new Error('Script runtime notice changed: ' + notice.file);
    assets.set(name, bytes); links.push('<li><a href="./' + notice.file + '">' + escape(notice.file) + '</a></li>');
  }
  assets.set('licenses/script-runtime/script-runtime-notices.json', data);
  assets.set('licenses/script-runtime/index.html', Buffer.from('<!doctype html><html lang="ja"><meta charset="utf-8">' +
    '<title>自動作図の実行部の許諾原文</title><h1>自動作図の実行部の許諾原文</h1>' +
    '<p>QuickJS-ngと組込みの実行用コードの許諾原文です。接続部分と資源制限の変更はPointerCADによるものです。</p><ul>' +
    links.join('\n') + '</ul><p><a href="../runtime/">利用部品一覧</a></p></html>', 'utf8'));
  return assets;
}
