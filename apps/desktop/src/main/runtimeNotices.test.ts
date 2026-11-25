import { readFileSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectRuntimeNotices, assertRuntimeNoticesPublishable } from '../../../../scripts/vite/runtimeNotices.mjs';
import { installedRuntimeDependencies, verifyRuntimeDependencyInventory } from '../../../../scripts/vite/runtimeDependencyInventory.mjs';
import { readFemDistributionGaps } from '../../../../scripts/vite/femRuntimeAssets.mjs';
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
    for (const key of ["'mathlive@0.110.0>@cortex-js/compute-engine'", 'mathlive@0.110.0>@cortex-js/compute-engine']) {
      reset();
      writeFileSync(join(folder, 'pnpm-lock.yaml'), `overrides:\n  ${key}: '-'\n`);
      expect(runtimeDependencySelection(folder)({ name: 'mathlive', version: '0.110.0',
        dependencies: { '@cortex-js/compute-engine': '0.58.0', kept: '1' } })).toEqual(['kept']);
    }
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
  it('数学以外の部品も含め、固定した11件と、11原文とOCCTの追加原文6件を両版へ渡す', () => {
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
    expect(originals).toBe(17);
    expect(distribution.assets.get('LICENSE')).toEqual(readFileSync(new URL('../../../../LICENSE', import.meta.url)));
    expect(distribution.assets.get('NOTICE')).toEqual(readFileSync(new URL('../../../../NOTICE', import.meta.url)));
  });
  it('OCCTの例外条項と組込み依存の原文をopencascade.jsへ紐づける', () => {
    const distribution = collectRuntimeNotices(root);
    expect(distribution.additionalNotices).toEqual([{
      appliesTo: 'opencascade.js',
      file: 'runtime-opencascade.js-2.0.0-beta.b5ff984-lgpl-exception.txt',
      sha256: '04580a884ea6cea294402649ff7b5cbb167d47462d1340a4ed33e550db10a81b',
    }, {
      appliesTo: 'opencascade.js',
      file: 'runtime-occt-freetype-version-1-license.txt',
      sha256: 'f6333b3a9106f10190e96d9f994f934deb7a5632851a1aaf846b94651a80f4da',
    }, {
      appliesTo: 'opencascade.js',
      file: 'runtime-occt-freetype-version-1-ftl.txt',
      sha256: 'f4b133e25df1f86ad3ffea453aa0e613f0474f34778dbbb3e437e7b2724937d8',
    }, {
      appliesTo: 'opencascade.js',
      file: 'runtime-occt-freetype-version-1-gplv2.txt',
      sha256: 'c4120c6752c910c299e3bd9cb3a46ff262c268303ca2069b61f92f10a5656c18',
    }, {
      appliesTo: 'opencascade.js',
      file: 'runtime-occt-rapidjson-license.txt',
      sha256: 'a140e5d46fe734a1c78f1a3c3ef207871dd75648be71fdda8e309b23ab8b1f32',
    }, {
      appliesTo: 'opencascade.js',
      file: 'runtime-occt-emscripten-3.1.14-license.txt',
      sha256: '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86',
    }]);
    const path = 'licenses/runtime/runtime-opencascade.js-2.0.0-beta.b5ff984-lgpl-exception.txt';
    expect(distribution.assets.has(path)).toBe(true);
    expect(distribution.assets.get(path)).toEqual(
      readFileSync(new URL('../../../../docs/standards/licenses/runtime-opencascade.js-2.0.0-beta.b5ff984-lgpl-exception.txt', import.meta.url)),
    );
  });
  it('既存の原文確認を保持し、現在の具体的な配布条件に未完了がなければ公開を許可する', () => {
    const distribution = collectRuntimeNotices(root);
    expect(readFemDistributionGaps(join(root, 'packages/fem/runtime'))).toEqual([]);
    expect(distribution.unresolved).toEqual([]);
    expect(() => assertRuntimeNoticesPublishable(distribution)).not.toThrow();
  });
  it.each([
    ['native rebuild', 'FEM: native rebuild evidence is absent or not pinned'],
    ['corresponding source closure', 'FEM: oofem required covered-source inventory differs'],
    ['other dependency', '@arnog/colors@0.7.0'],
  ])('%s の未完了を明示した配布は公開を拒否する', (_condition, gap) => {
    const distribution = collectRuntimeNotices(root);
    expect(() => assertRuntimeNoticesPublishable({ ...distribution, unresolved: [gap] }))
      .toThrow('Unresolved runtime notices: ' + gap);
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
