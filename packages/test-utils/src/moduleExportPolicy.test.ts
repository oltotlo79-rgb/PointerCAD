import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const exportRule = 'no-restricted-exports';
const productPaths = [
  'packages/kernel/src/index.ts', 'packages/expression/src/index.ts', 'packages/drawing/src/index.ts',
  'packages/io/src/index.ts', 'packages/model/src/index.ts', 'packages/fem/src/index.ts',
  'packages/ui/src/index.ts', 'apps/web/src/helpChunkPolicy.ts',
  'packages/ui/src/solid/holeThreadPropertyUpdates.ts',
  'packages/model/src/part/solidPlanKeyGeometry.ts', 'packages/model/src/kernelBridge/solidContracts.ts',
];
const exceptionPaths = [
  'packages/fem/src/workspace.test.ts', 'packages/ui/src/viewport/createViewportScene.test.ts',
  'packages/ui/src/shell/PropertyPanel.test.tsx', 'packages/model/src/example.config.ts',
  'apps/web/vite.config.ts', 'eslint.config.js', 'e2e/playwright.config.ts', 'e2e/tests/example.spec.ts',
];
const configurations = new Map<string, Linter.Config>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 正本の合成済み規則を使う。短い反例では無関係な型・書式検査だけを対象外にする。
beforeAll(async () => {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.js'), fix: false, cache: false });
  for (const path of [...productPaths, ...exceptionPaths]) {
    const effective: unknown = await eslint.calculateConfigForFile(path);
    if (!record(effective) || !record(effective.rules)) throw new Error(`Missing configuration: ${path}`);
    const rules: Linter.RulesRecord = {};
    for (const name of [exportRule, 'no-restricted-imports', 'no-restricted-syntax']) {
      const setting: unknown = effective.rules[name];
      if (setting === undefined) continue;
      if (!Array.isArray(setting) || (setting[0] !== 2 && setting[0] !== 'error')) {
        throw new Error(`Rule is disabled or malformed: ${path} ${name}`);
      }
      const parts: readonly unknown[] = setting;
      rules[name] = [2, ...parts.slice(1)];
    }
    if (productPaths.includes(path) && !rules[exportRule]) throw new Error(`Missing product export rule: ${path}`);
    if (exceptionPaths.includes(path) && rules[exportRule]) throw new Error(`Unexpected export rule: ${path}`);
    configurations.set(path, { files: ['**/*.{js,mjs,ts,tsx}'],
      languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' }, rules });
  }
});

function lint(path: string, source: string): Linter.LintMessage[] {
  const configuration = configurations.get(path);
  if (!configuration) throw new Error(`Missing effective rules: ${path}`);
  const messages = new Linter().verify(source, [configuration], { filename: path });
  expect(messages.some(message => message.fatal), `${path}: ${source}`).toBe(false);
  return messages;
}

describe('製品のdefault exportを全形式と狭い上書き先でも拒否する', () => {
  const rejected = [
    { name: '値', source: 'export default 1;' },
    { name: '関数', source: 'export default function value() {}' },
    { name: 'class', source: 'export default class Value {}' },
    { name: 'interface', source: 'export default interface Value { value: number }' },
    { name: 'local alias', source: 'const value = 1; export { value as default };' },
    { name: '文字列alias', source: 'const value = 1; export { value as "default" };' },
    { name: 'default再公開', source: "export { default } from './value.js';" },
    { name: 'namedからdefault再公開', source: "export { value as default } from './value.js';" },
    { name: 'namespaceからdefault再公開', source: "export * as default from './value.js';" },
    { name: '型からdefault再公開', source: "export type { Value as default } from './value.js';" },
  ];
  for (const example of rejected) {
    it(example.name, () => {
      for (const path of productPaths) {
        expect(lint(path, example.source).filter(message => message.ruleId === exportRule), path).toHaveLength(1);
      }
    });
  }
});

it('test/configの例外と製品外の設定・E2Eを許容する', () => {
  // example.config/specとPropertyPanel.test.tsxは例外パターン確認用の仮想ファイル名。
  for (const path of exceptionPaths) {
    expect(lint(path, 'export default {};').filter(message => message.ruleId === exportRule), path).toEqual([]);
  }
});

it('named公開とdefaultのnamed適応を許容する', () => {
  for (const source of ['export const value = 1;', 'export interface Value { value: number }',
    "export { value } from './value.js';", "export * from './value.js';",
    "export { default as value } from './value.js';", "export * as values from './value.js';"]) {
    expect(lint('packages/kernel/src/index.ts', source)).toEqual([]);
  }
});

it('正当な資産・query・Node・相対.jsとdynamic importを変更しない', () => {
  for (const source of ["import text from './program.py?raw';", "import url from './module.wasm?url';",
    "import Worker from './task.ts?worker';", "import data from './data.json' with { type: 'json' };",
    "import './style.css';", "import image from './icon.svg';", "import { join } from 'node:path';",
    "import { value } from './value.js';", "import('./value.js');", "import('./program.py?raw');", "import('node:fs/promises');"]) {
    expect(lint('packages/kernel/src/index.ts', source)).toEqual([]);
  }
});

describe('合成後も広い層と狭いモジュールの既存禁止を保持する', () => {
  const cases = [
    { path: 'packages/model/src/index.ts', source: "import { value } from '@pointercad/fem';", rule: 'no-restricted-imports' },
    { path: 'packages/model/src/kernelBridge/solidContracts.ts', source: "import('@pointercad/fem');", rule: 'no-restricted-syntax' },
    { path: 'packages/model/src/index.ts', source: "type Value = import('@pointercad/fem').Value;", rule: 'no-restricted-syntax' },
    { path: 'packages/fem/src/index.ts', source: "import { view } from '@pointercad/ui';", rule: 'no-restricted-imports' },
    { path: 'packages/fem/src/workspace.test.ts', source: "import('@pointercad/io');", rule: 'no-restricted-syntax' },
    { path: 'packages/fem/src/workspace.test.ts', source: 'beforeEach(() => mock.mockClear());', rule: 'no-restricted-syntax' },
    { path: 'packages/ui/src/index.ts', source: "import('@pointercad/expression/math/worker');", rule: 'no-restricted-syntax' },
    { path: 'packages/ui/src/solid/holeThreadPropertyUpdates.ts', source: "import { store } from '../store/useAppStore.js';", rule: 'no-restricted-syntax' },
    { path: 'packages/model/src/part/solidPlanKeyGeometry.ts', source: "import { resolvePart } from './resolvePart.js';", rule: 'no-restricted-syntax' },
  ];
  for (const example of cases) {
    it(`${example.path}: ${example.source}`, () => {
      expect(lint(example.path, example.source).some(message => message.ruleId === example.rule)).toBe(true);
    });
  }
});

it('既存の実資産入口と設定を制限規則が拒否しない', () => {
  for (const path of ['packages/ui/src/index.ts', 'apps/web/vite.config.ts', 'eslint.config.js']) {
    expect(lint(path, readFileSync(resolve(root, path), 'utf8'))).toEqual([]);
  }
  // Python本文のraw importは実UIの既存入口を読み、同じUI層の規則で確認する。
  const source = readFileSync(resolve(root, 'packages/ui/src/math/localExactMathEngine.ts'), 'utf8');
  expect(source).toContain('?raw');
  expect(lint('packages/ui/src/index.ts', source)).toEqual([]);
});
