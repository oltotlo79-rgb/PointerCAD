import { readFileSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectRuntimeNotices, assertRuntimeNoticesPublishable } from '../../../../scripts/vite/runtimeNotices.mjs';
import { installedRuntimeDependencies, verifyRuntimeDependencyInventory } from '../../../../scripts/vite/runtimeDependencyInventory.mjs';
import { runtimeDependencySelection } from '../../../../scripts/vite/runtimeDependencySelection.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
describe('配布に入る実行用部品の版・許諾原文・未取得を保持する', () => {
  it('承認済みの削除指定だけを読み、復活した旧計算部や変更された接続先を拒否する', () => {
    const folder = execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), 'removed-runtime-guard'],
      { cwd: root, encoding: 'utf8' }).trim();
    const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    const reset = () => { writeFileSync(join(folder, 'pnpm-workspace.yaml'), workspace); writeFileSync(join(folder, 'pnpm-lock.yaml'), lock); };
    reset();
    const select = runtimeDependencySelection(folder);
    expect(select({ name: 'mathlive', version: '0.110.0', dependencies: { '@cortex-js/compute-engine': '0.58.0', kept: '1' } })).toEqual(['kept']);
    expect(() => select({ name: 'mathlive', version: '0.111.0', dependencies: { '@cortex-js/compute-engine': '0.58.0' } })).toThrow('changed mathematics editor');
    for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
      reset();
      writeFileSync(join(folder, file), readFileSync(join(folder, file), 'utf8').replace('overrides:', 'ignored-removal:'));
      expect(() => runtimeDependencySelection(folder)).toThrow('Unverified');
    }
    for (const name of ['@arnog/colors', '@cortex-js/compute-engine', 'quickjs-wasi', 'complex-esm']) {
      reset(); writeFileSync(join(folder, 'pnpm-lock.yaml'), lock + `\n  '${name}@9.0.0': {}\n`);
      expect(() => runtimeDependencySelection(folder)).toThrow('still locked');
    }
  });
  it('数学以外の部品も含め、固定した11件と11原文を両版へ渡す', () => {
    const dependencies = installedRuntimeDependencies(root), distribution = collectRuntimeNotices(root);
    expect(dependencies).toHaveLength(11);
    expect(dependencies.some(item => ['quickjs-wasi', '@cortex-js/compute-engine', '@arnog/colors', 'complex-esm'].includes(item.name))).toBe(false);
    for (const name of ['react', 'react-dom', 'scheduler', 'zustand', 'three', 'opencascade.js']) {
      expect(dependencies.some(item => item.name === name)).toBe(true);
    }
    let originals = 0;
    for (const [path, bytes] of distribution.assets) {
      if (!path.startsWith('licenses/runtime/') || !path.endsWith('.txt')) continue;
      const name = path.slice('licenses/runtime/'.length);
      expect(bytes).toEqual(readFileSync(new URL('../../../../docs/standards/licenses/' + name, import.meta.url)));
      originals += 1;
    }
    expect(originals).toBe(11);
    expect(distribution.assets.get('LICENSE')).toEqual(readFileSync(new URL('../../../../LICENSE', import.meta.url)));
    expect(distribution.assets.get('NOTICE')).toEqual(readFileSync(new URL('../../../../NOTICE', import.meta.url)));
  });
  it('未確認の部品を除いた実依存は公開可能とし、未確認が再混入した場合は公開を拒否する', () => {
    const distribution = collectRuntimeNotices(root);
    expect(distribution.unresolved).toEqual([]);
    expect(() => assertRuntimeNoticesPublishable(distribution)).not.toThrow();
    expect(() => assertRuntimeNoticesPublishable({ ...distribution, unresolved: ['@arnog/colors@0.7.0'] })).toThrow('Unresolved runtime notices');
  });
  it('保存前の写しでも元のプロジェクト内の実依存を検査し', () => {
    const folder = execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), 'runtime-notice-shadow'],
      { cwd: root, encoding: 'utf8' }).trim();
    for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) copyFileSync(join(root, file), join(folder, file));
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
