import { builtinModules, isBuiltin } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { ESLint, Linter, type Rule } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const nodeRule = 'module-style/node-prefix';
const paths = [
  'packages/kernel/src/index.ts', 'packages/model/src/kernelBridge/solidContracts.ts',
  'packages/model/src/part/solidPlanKeyGeometry.ts', 'packages/ui/src/solid/holeThreadPropertyUpdates.ts',
  'packages/ui/src/solid/SectionViewSection.tsx', 'packages/fem/src/workspace.test.ts',
  'apps/web/vite.config.ts', 'eslint.config.js', 'scripts/lint.mjs',
  'packages/model/src/index.ts', 'packages/fem/src/index.ts', 'packages/ui/src/index.ts',
];
const builtins = builtinModules.filter(name => !name.startsWith('node:') && isBuiltin(name));
const configurations = new Map<string, Linter.Config>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ruleModule(value: unknown): value is Rule.RuleModule {
  return record(value) && typeof value.create === 'function' && record(value.meta)
    && value.meta.type === 'problem' && Array.isArray(value.meta.schema);
}

function nodePlugin(value: unknown): value is ESLint.Plugin {
  return record(value) && record(value.rules) && ruleModule(value.rules['node-prefix']);
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
    for (const name of [nodeRule, 'no-restricted-imports', 'no-restricted-syntax', 'no-restricted-exports']) {
      const setting: unknown = effective.rules[name];
      if (setting === undefined) continue;
      if (!Array.isArray(setting) || (setting[0] !== 2 && setting[0] !== 'error')) {
        throw new Error(`Rule is disabled or malformed: ${path} ${name}`);
      }
      const parts: readonly unknown[] = setting;
      rules[name] = [2, ...parts.slice(1)];
    }
    if (!rules[nodeRule]) throw new Error(`Node prefix rule is not enabled: ${path}`);
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

describe('Node組込みの非node:参照をliteralの各構文で拒否する', () => {
  const forms = [
    { name: 'static import', source: (name: string) => `import value from '${name}';` },
    { name: 'named export-from', source: (name: string) => `export { value } from '${name}';` },
    { name: 'all export-from', source: (name: string) => `export * from '${name}';` },
    { name: 'dynamic import', source: (name: string) => `import('${name}');` },
    { name: 'TSImportType', source: (name: string) => `type Value = import('${name}').Value;` },
  ];
  for (const form of forms) {
    it(form.name, () => {
      for (const path of paths) {
        for (const name of (path === 'packages/kernel/src/index.ts' ? builtins : ['fs', 'fs/promises'])) {
          const messages = lint(path, form.source(name)).filter(message => message.ruleId === nodeRule);
          expect(messages, `${path}: ${name}`).toHaveLength(1);
          expect(messages[0]?.messageId).toBe('nodePrefix');
        }
      }
    });
  }
});

it('実builtinとsubpathのnode:付き表記をすべて許容する', () => {
  for (const name of [...builtins.map(value => `node:${value}`), ...builtinModules.filter(value => value.startsWith('node:'))]) {
    for (const source of [`import value from '${name}';`, `export * from '${name}';`,
      `import('${name}');`, `type Value = import('${name}').Value;`]) {
      expect(lint('packages/kernel/src/index.ts', source)).toEqual([]);
    }
  }
});

it('第三者package・相対.js・非JS資産・Vite queryを組込みと誤認しない', () => {
  for (const name of ['react', 'lodash/fp', '@pointercad/test-utils', 'path-browserify', 'fs-extra',
    './value.js', './program.py?raw', './module.wasm?url', './task.ts?worker', './style.css', './icon.svg', './data.json', 'fs?raw']) {
    for (const source of [`import value from '${name}';`, `export * from '${name}';`, `import('${name}');`]) {
      expect(lint('packages/kernel/src/index.ts', source)).toEqual([]);
    }
  }
});

it('非literal・template・requireと無関係な文字列を評価しない', () => {
  for (const source of ["import(name);", "import('f' + 's');", 'import(`fs`);',
    "require('fs');", "const value = 'fs';", "const value = { source: 'fs' };", "type Value = 'fs';"]) {
    expect(lint('packages/kernel/src/index.ts', source)).toEqual([]);
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
      expect(messages.filter(message => message.ruleId === nodeRule)).toEqual([]);
    });
  }
});

it('既存の実設定とJS入口のNode参照を拒否しない', () => {
  for (const path of ['eslint.config.js', 'apps/web/vite.config.ts', 'scripts/lint.mjs']) {
    expect(lint(path, readFileSync(resolve(root, path), 'utf8')).filter(message => message.ruleId === nodeRule)).toEqual([]);
  }
});
