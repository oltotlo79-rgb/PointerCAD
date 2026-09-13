import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

it('両版のビルド設定から読むローカル実装を、Gitの除外フォルダーへ置かない', () => {
  const available = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' }).split('\0'));
  const pending = [resolve(root, 'apps/web/vite.config.ts'), resolve(root, 'apps/desktop/vite.renderer.config.ts')];
  const checked = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || checked.has(path)) continue;
    checked.add(path);
    const name = relative(root, path).replaceAll('\\', '/');
    expect(name.startsWith('../'), `ビルド入力がリポジトリ外です: ${name}`).toBe(false);
    expect(available.has(name), `ビルド入力をGitで取得できません: ${name}`).toBe(true);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (specifier === undefined) throw new Error('ビルド入力の参照名を取得できません。');
      const imported = resolve(dirname(path), specifier);
      const candidates = [imported, imported.replace(/\.js$/u, '.ts'), imported.replace(/\.js$/u, '.tsx')];
      const found = candidates.find(candidate => existsSync(candidate));
      expect(found, `ビルド入力の参照先がありません: ${match[1]}`).toBeDefined();
      if (found !== undefined && ['.mjs', '.js', '.ts', '.tsx'].includes(extname(found))) pending.push(found);
      if (found?.endsWith('.mjs')) {
        const declaration = found.replace(/\.mjs$/u, '.d.mts');
        if (existsSync(declaration)) pending.push(declaration);
      }
    }
  }
});
