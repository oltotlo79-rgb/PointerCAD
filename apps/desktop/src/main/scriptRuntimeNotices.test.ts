import { readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectScriptRuntimeNotices } from '../../../../scripts/vite/scriptRuntimeNotices.mjs';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
function fixture(): string {
  const folder = execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), 'native-license-check'],
    { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const vendor = 'packages/model/src/vendor/script-runtime', notices = 'docs/standards/licenses';
  const manifest = JSON.parse(readFileSync(join(root, notices, 'script-runtime-notices.json'), 'utf8')) as { notices: { file: string }[] };
  for (const file of [...['manifest.json', 'build-config.json', 'quickjs-pcad.wasm', 'pcad-interface.c', 'resource-limits.patch'].map(name => `${vendor}/${name}`),
    `${notices}/script-runtime-notices.json`, ...manifest.notices.map(item => `${notices}/${item.file}`)]) {
    const target = join(folder, file); mkdirSync(join(target, '..'), { recursive: true }); copyFileSync(join(root, file), target);
  }
  return folder;
}
describe('自動作図の配布物と生成元の許諾を同時に照合する', () => {
  it('実WASM・独自の接続・資源制限と12原文を照合して両版へ同梱する', () => {
    const assets = collectScriptRuntimeNotices(root);
    expect([...assets.keys()].filter(file => file.endsWith('.txt'))).toHaveLength(12);
    expect(assets.get('licenses/script-runtime/quickjs-ng.txt')).toEqual(readFileSync(join(root, 'docs/standards/licenses/quickjs-ng.txt')));
    const dependencies = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    expect(dependencies).not.toContain('quickjs-wasi');
  });
  it.each(['pcad-interface.c', 'quickjs-pcad.wasm'])('%sの変更を同梱前に拒否する', name => {
    const folder = fixture(), file = join(folder, 'packages/model/src/vendor/script-runtime', name);
    const bytes = readFileSync(file); bytes[bytes.length - 1] ^= 1; writeFileSync(file, bytes);
    expect(() => collectScriptRuntimeNotices(folder)).toThrow(/Script runtime (source|binary) changed/u);
  });
  it('未確認の接続ソースが作成手順へ戻る変更を拒否する', () => {
    const folder = fixture(), file = join(folder, 'packages/model/src/vendor/script-runtime/build-config.json');
    const config = JSON.parse(readFileSync(file, 'utf8')) as { inputs: { name: string }[] };
    config.inputs.push({ name: 'interface.c' }); writeFileSync(file, JSON.stringify(config));
    expect(() => collectScriptRuntimeNotices(folder)).toThrow('Unreviewed script runtime build source');
  });
  it('原文の改変と欠落を拒否する', () => {
    const folder = fixture(); writeFileSync(join(folder, 'docs/standards/licenses/quickjs-ng.txt'), 'MIT');
    expect(() => collectScriptRuntimeNotices(folder)).toThrow('Script runtime notice changed');
  });
});
