import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildExactMathAssets, collectExactMathAssets } from '../../../../scripts/vite/exactMathAssets.mjs';

const folder = fileURLToPath(new URL('../../../../vendor/exact-math/', import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(entries: readonly (readonly [string, Buffer])[] = [
  ['runtime/main.mjs', Buffer.from('fixed runtime')], ['notices/LICENSE.txt', Buffer.from('original\r\nnotice\n')],
]) {
  const files = new Map(entries);
  return { files, manifest: {
    format: 'pointercad-exact-runtime/1',
    files: Object.fromEntries(entries.map(([name, bytes]) => [name, { bytes: bytes.byteLength, sha256: sha256(bytes) }])),
    components: { 'Example component': ['LICENSE.txt'] },
  } };
}

describe('承認した追加計算部の実行ファイル・原文・関連ソースを同じ内容で配布する', () => {
  it('固定した実部品と21部品の原文を含み、25MiBを超えず元のソース書庫へ完全復元できる', () => {
    const assets = collectExactMathAssets();
    for (const file of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip',
      'pyodide-lock.json', 'sympy-1.14.0-py3-none-any.whl', 'mpmath-1.3.0-py3-none-any.whl']) {
      const actual = assets.get('exact-math/runtime/' + file), original = readFileSync(join(folder, 'runtime', file));
      expect(actual?.byteLength).toBe(original.byteLength);
      expect(actual === undefined ? '' : sha256(actual)).toBe(sha256(original));
    }
    const index = assets.get('licenses/exact-math/index.html')?.toString('utf8') ?? '';
    expect(index).toContain('Pyodide 314.0.6');
    expect(index).toContain('Hiwire 6a1e672');
    expect(index).toContain('sympy 1.14.0');
    expect(index).toContain('mpmath 1.3.0');
    for (const bytes of assets.values()) expect(bytes.byteLength).toBeLessThanOrEqual(25 * 1024 * 1024);
    // 固定原本は30,601,597バイトと34,477,324バイト。16MiB単位でそれぞれ2/3分割。
    for (const [name, count] of [['Python-3.14.2.tgz', 2],
      ['emscripten-source-285c424dfa9e83b03cf8490c65ceadb7c45f28eb.tgz', 3]] as const) {
      const prefix = 'licenses/exact-math/sources/' + name;
      const parts = [...assets.entries()].filter(([path]) => path.startsWith(prefix + '.part-')).sort(([a], [b]) => a.localeCompare(b));
      expect(parts).toHaveLength(count);
      const restored = Buffer.concat(parts.map(([, bytes]) => bytes));
      const original = readFileSync(join(folder, 'sources', name));
      expect(restored.byteLength).toBe(original.byteLength);
      expect(sha256(restored)).toBe(sha256(original));
      expect(assets.get('licenses/exact-math/manifest.json')?.toString('utf8')).toContain(sha256(restored));
      for (const [path] of parts) expect(index).toContain(path.slice('licenses/exact-math/'.length));
    }
    expect((index.split('<h2>')[0].match(/<li>[^<]*: <a href="\.\/notices\//gu) ?? []).length).toBe(21);
  });

  it('Windowsでも許諾原文と実行部にGitの改行変換を適用しない', () => {
    for (const name of ['runtime/pyodide.mjs', 'notices/pyodide-314.0.6-LICENSE.txt', 'notices/emscripten-5.0.3-mini-lz4.js']) {
      const output = execFileSync('git', ['check-attr', 'text', '--', 'vendor/exact-math/' + name], { cwd: root, encoding: 'utf8' });
      expect(output.trim()).toBe('vendor/exact-math/' + name + ': text: unset');
    }
  });

  it('LFとCRLFが混在する原文も変換せず配布する', () => {
    const { files, manifest } = fixture();
    const assets = buildExactMathAssets(manifest, files);
    expect(assets.get('licenses/exact-math/notices/LICENSE.txt')).toEqual(Buffer.from('original\r\nnotice\n'));
  });

  it('同じ長さへの改変、欠落、未記録ファイルの追加を拒否する', () => {
    const { files, manifest } = fixture();
    const changed = new Map(files); changed.set('runtime/main.mjs', Buffer.from('other runtime'));
    expect(() => buildExactMathAssets(manifest, changed)).toThrow('input changed');
    const missing = new Map(files); missing.delete('runtime/main.mjs');
    expect(() => buildExactMathAssets(manifest, missing)).toThrow('inventory changed');
    const added = new Map(files); added.set('runtime/extra.mjs', Buffer.from('extra'));
    expect(() => buildExactMathAssets(manifest, added)).toThrow('inventory changed');
  });

  it('原文の割当てが欠落した部品を黙って配布しない', () => {
    const { files, manifest } = fixture();
    expect(() => buildExactMathAssets({ ...manifest, components: { missing: ['ABSENT.txt'] } }, files)).toThrow('notice is missing');
  });

  it.each(['../outside', 'notices/../outside', 'runtime//main', '/runtime/main', 'runtime/a?query', 'runtime/a#fragment'])(
    '不正なファイル名%sを配布しない', name => {
      const { files, manifest } = fixture([[name, Buffer.from('x')], ['notices/LICENSE.txt', Buffer.from('notice')]]);
      expect(() => buildExactMathAssets(manifest, files)).toThrow('input changed');
    });

  it('大文字小文字の違いだけで同じファイルを二重に配布しない', () => {
    const { files, manifest } = fixture([['runtime/a', Buffer.from('a')], ['runtime/A', Buffer.from('b')]]);
    expect(() => buildExactMathAssets(manifest, files)).toThrow('input changed');
  });

  it('分割先と別ファイルの名前が衝突したら内容を上書きせず拒否する', () => {
    const { files, manifest } = fixture([['sources/archive', Buffer.alloc(16 * 1024 * 1024 + 1, 17)],
      ['sources/archive.part-001', Buffer.from('separate source')], ['notices/LICENSE.txt', Buffer.from('notice')]]);
    expect(() => buildExactMathAssets(manifest, files)).toThrow('output collision');
  });
});
