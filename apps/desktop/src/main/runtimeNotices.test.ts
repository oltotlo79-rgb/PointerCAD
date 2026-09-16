import { readFileSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectRuntimeNotices, assertRuntimeNoticesPublishable } from '../../../../scripts/vite/runtimeNotices.mjs';
import { installedRuntimeDependencies, verifyRuntimeDependencyInventory } from '../../../../scripts/vite/runtimeDependencyInventory.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
describe('配布に入る実行用部品の版・許諾原文・未取得を保持する', () => {
  it('数学以外の部品も含め、固定した17件と14原文を両版へ渡す', () => {
    const dependencies = installedRuntimeDependencies(root), distribution = collectRuntimeNotices(root);
    expect(dependencies).toHaveLength(17);
    for (const name of ['react', 'react-dom', 'scheduler', 'zustand', 'three', 'opencascade.js', 'quickjs-wasi']) {
      expect(dependencies.some(item => item.name === name)).toBe(true);
    }
    let originals = 0;
    for (const [path, bytes] of distribution.assets) {
      if (!path.startsWith('licenses/runtime/') || !path.endsWith('.txt')) continue;
      const name = path.slice('licenses/runtime/'.length);
      expect(bytes).toEqual(readFileSync(new URL('../../../../docs/standards/licenses/' + name, import.meta.url)));
      originals += 1;
    }
    expect(originals).toBe(14);
    expect(distribution.assets.get('LICENSE')).toEqual(readFileSync(new URL('../../../../LICENSE', import.meta.url)));
    expect(distribution.assets.get('NOTICE')).toEqual(readFileSync(new URL('../../../../NOTICE', import.meta.url)));
  });
  it('原文を持たない3件を別部品の原文で埋めず、正式公開を拒否する', () => {
    const distribution = collectRuntimeNotices(root);
    expect(distribution.unresolved.sort()).toEqual(['@arnog/colors@0.5.0', '@arnog/colors@0.7.0', 'quickjs-wasi@3.6.0']);
    for (const name of ['@arnog/colors', 'quickjs-wasi']) {
      expect(distribution.assets.get('licenses/runtime/index.html')?.toString('utf8')).toContain(name);
    }
    expect(() => assertRuntimeNoticesPublishable(distribution)).toThrow('Unresolved runtime notices');
  });
  it('保存前の写しでも元のプロジェクト内の実依存を検査し', () => {
    const folder = execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), 'runtime-notice-shadow'],
      { cwd: root, encoding: 'utf8' }).trim();
    for (const owner of ['apps/web', 'apps/desktop']) {
      mkdirSync(join(folder, owner), { recursive: true });
      copyFileSync(join(root, owner, 'package.json'), join(folder, owner, 'package.json'));
      symlinkSync(join(root, owner, 'node_modules'), join(folder, owner, 'node_modules'), 'junction');
    }
    const withoutPaths = (repository: string) => installedRuntimeDependencies(repository)
      .map(({ name, version, license }) => ({ name, version, license }));
    expect(withoutPaths(folder)).toEqual(withoutPaths(root));
  });
  it('依存・版・許諾の変更や重複を見落とさない', () => {
    const first = { name: 'first', version: '1', license: 'MIT' }, second = { name: 'second', version: '1', license: 'MIT' };
    expect(() => verifyRuntimeDependencyInventory([first, second], [first])).toThrow();
    expect(() => verifyRuntimeDependencyInventory([first], [first, second])).toThrow();
    expect(() => verifyRuntimeDependencyInventory([first, first], [first, second])).toThrow();
    expect(() => verifyRuntimeDependencyInventory([first, second], [first, first])).toThrow();
    expect(() => verifyRuntimeDependencyInventory([{ ...first, version: '2' }], [first])).toThrow();
    expect(() => verifyRuntimeDependencyInventory([{ ...first, license: 'BSD-3-Clause' }], [first])).toThrow();
  });
});
