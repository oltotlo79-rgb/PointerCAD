import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { ESLint, Linter, type Rule } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const nodeRule = 'module-style/node-prefix';
const relativeRule = 'module-style/relative-js-extension';
const vitestRule = 'module-style/vitest-it';
const paths = [
  'packages/kernel/src/index.ts', 'packages/model/src/kernelBridge/solidContracts.ts',
  'packages/model/src/part/solidPlanKeyGeometry.ts', 'packages/ui/src/solid/holeThreadPropertyUpdates.ts',
  'packages/ui/src/solid/SectionViewSection.tsx', 'packages/fem/src/workspace.test.ts',
  'apps/web/vite.config.ts', 'eslint.config.js', 'scripts/lint.mjs',
  'packages/model/src/index.ts', 'packages/fem/src/index.ts', 'packages/ui/src/index.ts',
  'apps/web/src/startupMarkup.test.ts',
];
const configurations = new Map<string, Linter.Config>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ruleModule(value: unknown): value is Rule.RuleModule {
  return record(value) && typeof value.create === 'function' && record(value.meta)
    && value.meta.type === 'problem' && Array.isArray(value.meta.schema);
}

function nodePlugin(value: unknown): value is ESLint.Plugin {
  if (!record(value) || !record(value.rules)) return false;
  const rules = value.rules;
  return ['node-prefix', 'relative-js-extension', 'vitest-it'].every(name => ruleModule(rules[name]));
}

// 実効ID・pluginを正本から取得し、短い入力には無関係な型・書式規則だけを適用しない。
beforeAll(async () => {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.js'), fix: false, cache: false });
  for (const path of paths) {
    const effective: unknown = await eslint.calculateConfigForFile(path);
    if (!record(effective) || !record(effective.rules) || !record(effective.plugins)) {
      throw new Error(`Missing effective configuration: ${path}`);
    }
    const plugin: unknown = effective.plugins['module-style'];
    if (!nodePlugin(plugin)) throw new Error(`Missing Node rule plugin: ${path}`);
    const rules: Linter.RulesRecord = {};
    for (const name of [relativeRule, vitestRule, nodeRule, 'no-restricted-imports', 'no-restricted-syntax', 'no-restricted-exports']) {
      const setting: unknown = effective.rules[name];
      if (setting === undefined) continue;
      if (!Array.isArray(setting) || (setting[0] !== 2 && setting[0] !== 'error')) {
        throw new Error(`Rule is disabled or malformed: ${path} ${name}`);
      }
      const parts: readonly unknown[] = setting;
      rules[name] = [2, ...parts.slice(1)];
    }
    if (!rules[nodeRule] || !rules[relativeRule] || !rules[vitestRule]) throw new Error(`Import style rules are not enabled: ${path}`);
    configurations.set(path, { files: ['**/*.{ts,tsx,js,mjs}'],
      languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
      plugins: { 'module-style': plugin }, rules });
  }
});

function lint(path: string, source: string): Linter.LintMessage[] {
  const config = configurations.get(path);
  if (!config) throw new Error(`Missing effective rules: ${path}`);
  const messages = new Linter().verify(source, [config], { filename: path });
  expect(messages.some(message => message.fatal), `${path}: ${source}`).toBe(false);
  return messages;
}

const forms = [
  { name: 'static import', source: (name: string) => `import value from '${name}';` },
  { name: 'named export-from', source: (name: string) => `export { value } from '${name}';` },
  { name: 'all export-from', source: (name: string) => `export * from '${name}';` },
  { name: 'dynamic import', source: (name: string) => `import('${name}');` },
  { name: 'TSImportType', source: (name: string) => `type Value = import('${name}').Value;` },
];

describe('相対コード参照は全構文と狭いoverrideでも.jsを必須にする', () => {
  for (const form of forms) {
    it(form.name, () => {
      for (const path of paths) {
        for (const name of ['./value', '../value', './value.ts', './view.tsx', './view.jsx', './value.mts',
          './value.cts', './value.ts?unknown', './value.ts?rawness', './value.ts#fragment?raw', '.', '..', './folder/']) {
          const messages = lint(path, form.source(name)).filter(message => message.ruleId === relativeRule);
          expect(messages, `${path}: ${name}`).toHaveLength(1);
          expect(messages[0]?.messageId).toBe('jsExtension');
        }
      }
    });
  }
});

describe('明示JS形式・資産・既定queryを同じ構文契約で保持する', () => {
  for (const form of forms) {
    it(form.name, () => {
      for (const name of ['./value.js', '../value.mjs', './value.cjs', './style.css', './icon.svg', './data.json',
        './program.py', './module.wasm', './page.html', './run.ps1', './image.png', './font.woff2',
        './program.py?raw', './module.wasm?url', './worker.ts?worker', './view.tsx?worker&inline',
        './bootstrap.ts?raw', './value?url', './value.ts?url&v=1', './value.js?unknown']) {
        expect(lint('packages/kernel/src/index.ts', form.source(name))).toEqual([]);
      }
    });
  }
});

describe('Vitestのnamed testだけを別名や型を含めて拒否する', () => {
  for (const source of ["import { test } from 'vitest';", "import { test as check } from 'vitest';",
    "import { it, test as check } from 'vitest';", "import type { test } from 'vitest';",
    "import { 'test' as check } from 'vitest';"]) {
    it(source, () => {
      for (const path of paths) {
        const messages = lint(path, source).filter(message => message.ruleId === vitestRule);
        expect(messages, path).toHaveLength(1);
        expect(messages[0]?.messageId).toBe('useIt');
      }
    });
  }
});

it('itの別名・他packageのtest・自前testを拒否しない', () => {
  for (const source of ["import { it } from 'vitest';", "import { it as check } from 'vitest';",
    "import { it as test } from 'vitest';", "import { test } from '@playwright/test';",
    "import { test } from 'node:test';", 'function test() {} test();',
    "import * as vitest from 'vitest';", "export { test } from 'vitest';"]) {
    expect(lint('packages/kernel/src/index.ts', source)).toEqual([]);
  }
});

it('非literal・template・require・package名を相対参照と誤認しない', () => {
  for (const source of ["import(name);", "import('./value' + suffix);", 'import(`./value`);',
    "require('./value');", "const source = './value';", "type Value = './value';",
    "import value from 'react';", "import value from '@scope/package';"]) {
    expect(lint('packages/kernel/src/index.ts', source)).toEqual([]);
  }
});

it('既存Node組込み前置規則を保持する', () => {
  for (const source of ["import value from 'fs/promises';", "import('fs');", "type Value = import('fs').Value;"]) {
    const messages = lint('packages/kernel/src/index.ts', source);
    expect(messages.filter(message => message.ruleId === nodeRule)).toHaveLength(1);
    expect(messages.filter(message => message.ruleId === relativeRule || message.ruleId === vitestRule)).toEqual([]);
  }
});

describe('既存の層・狭い構文禁止とdefault export禁止を上書きしない', () => {
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
    { path: 'packages/kernel/src/index.ts', source: 'export default 1;', rule: 'no-restricted-exports' },
  ];
  for (const example of cases) {
    it(`${example.path}: ${example.source}`, () => {
      const messages = lint(example.path, example.source);
      expect(messages.some(message => message.ruleId === example.rule)).toBe(true);
      expect(messages.filter(message => message.ruleId === nodeRule || message.ruleId === relativeRule || message.ruleId === vitestRule)).toEqual([]);
    });
  }
});

it('実.mjs・非JS資産・bootstrap.ts?rawの既存入口を保持する', () => {
  for (const path of ['eslint.config.js', 'apps/web/vite.config.ts', 'scripts/lint.mjs', 'apps/web/src/startupMarkup.test.ts']) {
    expect(lint(path, readFileSync(resolve(root, path), 'utf8')).filter(message => message.ruleId === nodeRule || message.ruleId === relativeRule || message.ruleId === vitestRule)).toEqual([]);
  }
});
