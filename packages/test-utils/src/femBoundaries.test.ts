import { readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('E01 counterexamples use the real project lint configuration', () => {
  for (const [filePath, source] of [
    ['packages/model/src/index.ts', "import '@pointercad/fem';"],
    ['packages/fem/src/index.ts', "import '@pointercad/ui';"],
  ]) {
    it(filePath, async () => {
      const eslint = new ESLint({ cwd: root, fix: false, cache: false });
      const messages = (await eslint.lintText(source, { filePath })).flatMap(result => result.messages);
      expect(messages.some(message => message.fatal), source).toBe(false);
      expect(messages.filter(message => message.ruleId === 'no-restricted-imports'), source).toHaveLength(1);
    });
  }
});

// Load merged, schema-validated rules for real filenames, including every narrower model override.
// Only unrelated type/style checks are omitted from these in-memory dependency probes.
const modelPaths = [
  'packages/model/src/index.ts',
  'packages/model/src/part/createPartDocument.test.ts',
  'packages/model/src/part/solidSketchReferences.ts',
  'packages/model/src/part/solidPlanKeyGeometry.ts',
  'packages/model/src/part/solidPlanKeyGeometry.test.ts',
  'packages/model/src/part/solidPlanKeyMaterial.ts',
  'packages/model/src/kernelBridge/subShapeMatching.ts',
  ...readdirSync(new URL('../../../packages/model/src/kernelBridge/', import.meta.url))
    .filter(name => /(?:Conversions|Contracts)\.ts$/.test(name)).sort()
    .map(name => `packages/model/src/kernelBridge/${name}`),
];
const femPaths = ['packages/fem/src/index.ts', 'packages/fem/src/workspace.test.ts'];
const configurations = new Map<string, Linter.Config>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

beforeAll(async () => {
  const eslint = new ESLint({ cwd: root });
  const paths = [...modelPaths, ...femPaths, 'packages/ui/src/index.ts',
    'packages/ui/src/beam/BeamPanel.tsx', 'packages/kernel/src/index.ts',
    'packages/expression/src/index.ts', 'packages/drawing/src/index.ts'];
  for (const path of paths) {
    const effective: unknown = await eslint.calculateConfigForFile(path);
    if (!record(effective) || !record(effective.rules)) throw new Error(`Missing configuration: ${path}`);
    const rules: Linter.RulesRecord = {};
    for (const name of ['no-restricted-imports', 'no-restricted-syntax']) {
      const setting: unknown = effective.rules[name];
      if (setting === undefined && name === 'no-restricted-syntax') continue;
      if (!Array.isArray(setting) || (setting[0] !== 2 && setting[0] !== 'error')) {
        throw new Error(`Boundary rule is missing or disabled: ${path} ${name}`);
      }
      const parts: readonly unknown[] = setting;
      rules[name] = [2, ...parts.slice(1)];
    }
    configurations.set(path, { files: ['**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' }, rules });
  }
});

function lint(path: string, source: string): Linter.LintMessage[] {
  const config = configurations.get(path);
  if (!config) throw new Error(`Missing effective boundary rules: ${path}`);
  const messages = new Linter().verify(source, [config], { filename: path });
  expect(messages.some(message => message.fatal), `${path}: ${source}`).toBe(false);
  return messages;
}

const forms = [
  { name: 'value import', rule: 'no-restricted-imports', source: (path: string) => `import { value } from '${path}';` },
  { name: 'type import', rule: 'no-restricted-imports', source: (path: string) => `import type { Value } from '${path}';` },
  { name: 'inline type import', rule: 'no-restricted-imports', source: (path: string) => `import { type Value } from '${path}';` },
  { name: 'named re-export', rule: 'no-restricted-imports', source: (path: string) => `export { value } from '${path}';` },
  { name: 'star re-export', rule: 'no-restricted-imports', source: (path: string) => `export * from '${path}';` },
  { name: 'type re-export', rule: 'no-restricted-imports', source: (path: string) => `export type { Value } from '${path}';` },
  { name: 'dynamic import', rule: 'no-restricted-syntax', source: (path: string) => `import('${path}');` },
  { name: 'type query', rule: 'no-restricted-syntax', source: (path: string) => `type Value = import('${path}').Value;` },
] as const;

function spellings(target: string, importer: string): string[] {
  return [`@pointercad/${target}`, `@pointercad/${target}/boundary`,
    posix.relative(posix.dirname(importer), `packages/${target}/src/index.js`),
    posix.relative(posix.dirname(importer), `packages/${target}/dist/index.js`)];
}

describe('model cannot depend on FEM through any narrower override or test rule', () => {
  for (const path of modelPaths) {
    for (const form of forms) {
      it(`${path}: ${form.name}`, () => {
        for (const specifier of spellings('fem', path)) {
          const source = form.source(specifier);
          const messages = lint(path, source);
          expect(messages.some(message => message.ruleId === form.rule), source).toBe(true);
          if (form.rule === 'no-restricted-syntax') {
            expect(messages.some(message => message.message.includes('modelからFEM')), source).toBe(true);
          }
        }
      });
    }
  }
});

describe('FEM cannot depend on UI, persistence, help or apps, even through types', () => {
  for (const path of femPaths) {
    const targets = [
      ...['ui', 'io', 'help-content'].map(name => ({ name, specifiers: spellings(name, path) })),
      ...['web', 'desktop'].map(name => ({ name: `${name} app`, specifiers: [
        `@pointercad/${name}`, `@pointercad/${name}/boundary`,
        posix.relative(posix.dirname(path), `apps/${name}/src/index.js`),
        posix.relative(posix.dirname(path), `apps/${name}/dist/index.js`),
      ] })),
    ];
    for (const target of targets) {
      for (const form of forms) {
        it(`${path} -> ${target.name}: ${form.name}`, () => {
          for (const specifier of target.specifiers) {
            const source = form.source(specifier);
            const messages = lint(path, source);
            expect(messages.some(message => message.ruleId === form.rule), source).toBe(true);
            if (form.rule === 'no-restricted-syntax') {
              expect(messages.some(message => message.message.includes('FEMはmodelを使う計算層')), source).toBe(true);
            }
          }
        });
      }
    }
  }
});

describe('downward paths preserve existing API restrictions and test-only utilities', () => {
  const cases = [
    ...['packages/model/src/index.ts', 'packages/model/src/part/createPartDocument.test.ts'].map(path => ({
      path, specifiers: ['@pointercad/kernel', '@pointercad/expression', '@pointercad/drawing', '@pointercad/test-utils'],
    })),
    ...femPaths.map(path => ({ path, specifiers: ['@pointercad/model', '@pointercad/model/beam-analysis',
      '../../model/src/analysis/solidCadInput.js', '../../model/dist/analysis/solidCadInput.js', '@pointercad/test-utils'] })),
    ...['packages/ui/src/index.ts', 'packages/ui/src/beam/BeamPanel.tsx'].map(path => ({
      path, specifiers: ['@pointercad/model', '@pointercad/fem', '@pointercad/test-utils'],
    })),
    ...['kernel', 'expression', 'drawing'].map(packageName => ({
      path: `packages/${packageName}/src/index.ts`, specifiers: ['@pointercad/test-utils'],
    })),
  ];
  for (const example of cases) {
    for (const form of forms) {
      it(`${example.path}: ${form.name}`, () => {
        for (const specifier of example.specifiers) {
          const messages = lint(example.path, form.source(specifier));
          if (example.path.startsWith('packages/ui/') && specifier === '@pointercad/model' && form.name === 'star re-export') {
            // UI may use model's public API, but must not re-export restricted low-level selection functions.
            expect(messages.some(message => message.ruleId === 'no-restricted-imports'), specifier).toBe(true);
          } else {
            expect(messages, specifier).toEqual([]);
          }
        }
      });
    }
  }
});

describe('adding dependency syntax guards preserves existing test syntax rules', () => {
  for (const path of [modelPaths[1], femPaths[1]]) {
    it(path, () => {
      expect(lint(path, 'beforeEach(() => mock.mockClear());')
        .some(message => message.ruleId === 'no-restricted-syntax' && message.message.includes('mockClear'))).toBe(true);
    });
  }
});
