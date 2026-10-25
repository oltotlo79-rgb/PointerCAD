import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it, vi } from 'vitest';
import { combineLintResults, lintGroupParts, listLintGroups } from '../../../scripts/lint.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ui = { label: 'packages/ui', args: ['packages/ui'] };

describe('UI lint分割の完全性', () => {
  it.each(['complete', 'sparse', 'remainder', 'empty', 'ignored', 'named-only', 'generated-heavy'] as const)('ESLintの元の選択と同じ全ファイルを重複なく点検する: %s', async (layout) => {
    const tempRoot = path.join(root, 'scratchpad/temp');
    mkdirSync(tempRoot, { recursive: true });
    const fixture = mkdtempSync(path.join(tempRoot, 'lint-groups-'));
    const files = [
      'packages/ui/vitest.config.mjs', 'packages/ui/integration/new.test.ts',
      'packages/ui/src/index.ts', 'packages/ui/src/new area/new.test.tsx',
      'packages/ui/src/sketch/numericInput.test.ts', 'packages/ui/src/sketch/.hidden.ts',
      'packages/ui/src/solid/nested/new.tsx', 'packages/ui/src/viewport/new.test.ts',
      'packages/ui/src/assembly/new.test.ts', 'packages/ui/src/beam/new.ts',
      'packages/ui/src/math/new.test.ts', 'packages/ui/src/drawing/new.tsx',
      'packages/ui/src/shell/new.test.tsx', 'packages/ui/src/store/new.ts',
      'packages/ui/src/sketch/dist/generated.ts', 'packages/ui/dist/generated.js',
      'packages/ui/src/sketch/image.css', 'packages/ui/node_modules/fake/index.js',
    ];
    try {
      const named = ['viewport', 'assembly', 'beam', 'sketch', 'math', 'drawing', 'solid', 'shell', 'store'];
      const included = files.filter((file) => layout === 'named-only'
        ? named.some((directory) => file.startsWith(`packages/ui/src/${directory}/`))
        : layout === 'complete' || layout === 'generated-heavy'
        || !named.some((directory) => file.startsWith(`packages/ui/src/${directory}/`))
        || (layout !== 'remainder' && file.startsWith('packages/ui/src/sketch/')));
      for (const file of included) {
        const destination = path.join(fixture, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, 'export const value = 1;\n');
      }
      if (layout === 'generated-heavy') {
        for (let index = 0; index < 130; index += 1) {
          const destination = path.join(fixture, 'packages/ui/dist', `ignored-${index}.d.ts`);
          mkdirSync(path.dirname(destination), { recursive: true });
          writeFileSync(destination, 'export declare const ignored: number;\n');
        }
      }
      if (layout === 'empty' || layout === 'ignored') {
        const empty = path.join(fixture, 'packages/ui/src/viewport');
        mkdirSync(empty, { recursive: true });
        if (layout === 'ignored') {
          mkdirSync(path.join(empty, 'dist'));
          writeFileSync(path.join(empty, 'dist/generated.ts'), 'export const ignored = 1;\n');
        }
      }
      const engine = (ignorePatterns: string[] = []) => new ESLint({
        cwd: fixture, overrideConfigFile: true, ignorePatterns,
        overrideConfig: [{ ignores: ['**/dist/**'] }, { files: ['**/*.ts', '**/*.tsx'] }],
      });
      const whole = (await engine().lintFiles(ui.args)).map((result) => path.relative(fixture, result.filePath)).sort();
      const selected: string[] = [];
      const parts = await lintGroupParts(ui, fixture, engine());
      expect(parts).toHaveLength(layout === 'complete' || layout === 'generated-heavy' ? 4 : layout === 'sparse' ? 2 : 1);
      for (const part of parts) {
        const separator = part.args.indexOf('--ignore-pattern');
        const paths = separator < 0 ? part.args : part.args.slice(0, separator);
        const ignores = separator < 0 ? [] : part.args.slice(separator).filter((_, index) => index % 2 === 1);
        selected.push(...(await engine(ignores).lintFiles(paths)).map((result) => path.relative(fixture, result.filePath)));
      }
      expect(selected.sort()).toEqual(whole);
      expect(new Set(selected).size).toBe(selected.length);
      expect(whole).toHaveLength(layout === 'complete' || layout === 'generated-heavy' ? 14 : layout === 'remainder' ? 4 : layout === 'named-only' ? 10 : 6);
      expect(listLintGroups(fixture).filter((group) => group.label === 'packages/ui')).toEqual([ui]);
      expect(await lintGroupParts({ label: 'packages/model', args: ['packages/model'] })).toEqual([{ label: 'packages/model', args: ['packages/model'] }]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('存在確認の権限・I/Oエラーを欠落として扱わない', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(() => { throw denied; });
    try {
      await expect(lintGroupParts(ui, root)).rejects.toThrow(denied);
    } finally {
      spy.mockRestore();
    }
  });

  it('通常違反・異常終了・シグナルの失敗と全出力を保持する', () => {
    const result = (status: number, signal: string | null, output: string) => ({ group: ui, status, signal, seconds: 1, output });
    const success = result(0, null, 'ok\n');
    const violation = result(1, null, 'lint\n');
    const fatal = result(134, null, 'heap\n');
    const signal = result(1, 'SIGTERM', 'signal\n');
    expect(combineLintResults(ui, [success, violation, fatal])).toMatchObject({ group: ui, status: 134, seconds: 3, output: 'ok\nlint\nheap\n' });
    expect(combineLintResults(ui, [success, violation])).toMatchObject({ status: 1, output: 'ok\nlint\n' });
    expect(combineLintResults(ui, [success, signal])).toMatchObject({ status: 1, signal: 'SIGTERM' });
    expect(combineLintResults(ui, [violation, signal])).toMatchObject({ status: 1, signal: 'SIGTERM', output: 'lint\nsignal\n' });
    expect(combineLintResults(ui, [success])).toMatchObject({ status: 0, signal: null });
  });

  it.each([['--version'], ['--no-such-option-for-lint-regression']])('明示CLI引数をそのままESLintへ渡す: %j', (args) => {
    const require = createRequire(import.meta.url);
    const eslint = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin/eslint.js');
    const direct = spawnSync(process.execPath, [eslint, ...args], { cwd: root, encoding: 'utf8' });
    const wrapper = spawnSync(process.execPath, [path.join(root, 'scripts/lint.mjs'), ...args], { cwd: root, encoding: 'utf8' });
    expect(wrapper.status).toBe(direct.status);
    expect(wrapper.stdout).toBe(direct.stdout);
    expect(wrapper.stderr).toBe(direct.stderr);
  });
});
