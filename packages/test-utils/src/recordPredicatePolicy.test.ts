import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rule = 'record-guard/canonical';
let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.js'), fix: false, cache: false,
    overrideConfig: [{ ...tseslint.configs.disableTypeChecked, files: ['**/*.ts'] }] });
});

async function messages(path: string, source: string) {
  const results = await eslint.lintText(source, { filePath: resolve(root, path) });
  expect(results).toHaveLength(1);
  expect(results[0]?.messages.some(message => message.fatal)).toBe(false);
  return results[0]?.messages ?? [];
}

const productPaths = [
  'packages/model/src/assembly/partLibrary.ts',
  'packages/model/src/drawing/sourceLibrary.ts',
  'packages/model/src/part/solidPlanKeyGeometry.ts',
  'packages/model/src/kernelBridge/solidContracts.ts',
];

describe('record判定の再定義は狭い構成規則があっても拒否する', () => {
  const declarations = [
    'function isRecord(value: unknown) { return value !== null; }',
    'export function isRecord(value: unknown) { return value !== null; }',
    'const isRecord = (value: unknown) => value !== null;',
    'let isRecord = function (value: unknown) { return value !== null; };',
    'const guard = function isRecord(value: unknown) { return value !== null; };',
  ];
  it.each(declarations)('%s', async source => {
    for (const path of productPaths) {
      expect((await messages(path, source)).filter(message => message.ruleId === rule), path).toHaveLength(1);
    }
  });
});

it('正本・検査用の局所判定・対象外パッケージを拒否しない', async () => {
  for (const path of ['packages/model/src/valueGuards.ts',
    'packages/model/src/assembly/partLibrary.test.ts', 'packages/model/src/assembly/value.testSupport.ts',
    'packages/fem/src/protocol.ts']) {
    expect((await messages(path, 'export function isRecord(value: unknown) { return value !== null; }'))
      .filter(message => message.ruleId === rule), path).toEqual([]);
  }
});

it('正本のimportと利用、型名とオブジェクトのメソッド名を保つ', async () => {
  for (const source of [
    "import { isRecord } from '../valueGuards.js'; export const valid = isRecord({});",
    'interface Value { isRecord: boolean }',
    'export const object = { isRecord(value: unknown) { return value !== null; } };',
  ]) {
    expect((await messages(productPaths[0], source)).filter(message => message.ruleId === rule)).toEqual([]);
  }
});

it('既存の逆向き依存と契約モジュールの実装禁止を弱めない', async () => {
  const results = await messages('packages/model/src/kernelBridge/solidContracts.ts',
    "import { value } from '@pointercad/fem'; export function isRecord(input: unknown) { return !!input; }");
  expect(results.some(message => message.ruleId === 'no-restricted-imports')).toBe(true);
  expect(results.some(message => message.ruleId === 'no-restricted-syntax')).toBe(true);
  expect(results.filter(message => message.ruleId === rule)).toHaveLength(1);
});
