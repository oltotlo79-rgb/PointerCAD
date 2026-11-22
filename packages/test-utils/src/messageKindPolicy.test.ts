/**
 * 失敗の種類を誤りの文の一致で決めない決まり(failure-kind/no-message-text-match、eslint.messageKind.js)の見張り。
 * 1. 断る書き方・断らない書き方を、製品のパスに置いた文で確かめる(eslint.config.js の配線ごと)。
 * 2. 製品の全部のファイルを数え、表(MESSAGE_KIND_BASELINE)とファイルごとに一致する事(増えても減っても落ちる。toleranceBaseline と同じ見張り方)。
 * 3. 表の各行が、在るファイル・理由・直す予定を持つ事。
 * 4. 失敗の文(欄 text)の鍵を持ち出す書き方の決まり(failure-text/no-key-as-text、同じファイル)の見本と、製品の当たりが 0 である事。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { ESLint, Linter, type Rule } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { productFiles } from './packageImportBoundary.testSupport.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const RULE = 'failure-kind/no-message-text-match';
const TEXT_RULE = 'failure-text/no-key-as-text';
const KINDS = new Set(['external', 'boundary', 'internal']);

interface BaselineRow { readonly file: string; readonly count: number; readonly kind: string; readonly reason: string; readonly plannedFix: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function baselineRow(value: unknown): value is BaselineRow {
  return record(value) && typeof value.file === 'string' && typeof value.count === 'number' && typeof value.kind === 'string'
    && typeof value.reason === 'string' && typeof value.plannedFix === 'string';
}
function ruleModule(value: unknown): value is Rule.RuleModule {
  return record(value) && typeof value.create === 'function';
}

let baseline: readonly BaselineRow[] = [];
let rule: Rule.RuleModule;
let textRule: Rule.RuleModule;
let eslint: ESLint;

beforeAll(async () => {
  const loaded: unknown = await import(new URL('../../../eslint.messageKind.js', import.meta.url).href);
  if (!record(loaded) || !Array.isArray(loaded.MESSAGE_KIND_BASELINE) || !ruleModule(loaded.messageKindRule)
    || !ruleModule(loaded.failureTextKeyRule)) {
    throw new Error('eslint.messageKind.js must export MESSAGE_KIND_BASELINE, messageKindRule and failureTextKeyRule');
  }
  const rows: unknown[] = loaded.MESSAGE_KIND_BASELINE;
  if (!rows.every(baselineRow)) throw new Error('MESSAGE_KIND_BASELINE rows must have file, count, kind, reason and plannedFix');
  baseline = rows;
  rule = loaded.messageKindRule;
  textRule = loaded.failureTextKeyRule;
  eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.js'), fix: false, cache: false,
    overrideConfig: [{ ...tseslint.configs.disableTypeChecked, files: ['**/*.ts'] }] });
});

async function hits(path: string, source: string, ruleId: string = RULE): Promise<number> {
  const results = await eslint.lintText(source, { filePath: resolve(root, path) });
  expect(results).toHaveLength(1);
  expect(results[0]?.messages.some(message => message.fatal)).toBe(false);
  return (results[0]?.messages ?? []).filter(message => message.ruleId === ruleId).length;
}

const PROBE = 'packages/model/src/part/messageKindProbe.ts';

describe('失敗の種類を誤りの文の一致で決める書き方は断る', () => {
  it.each([
    "declare const error: { message: string }; const MARK = 'x'; export const a = error.message === MARK;",
    "declare const message: string; export const a = message.includes('asset-missing:');",
    'declare const error: Error; export const a = /net::ERR/u.test(error.message);',
    "declare const message: string; declare function t(key: string): string; export const a = message === t('a.b');",
    'declare const failure: { message: string }; export function f(): number { switch (failure.message) { default: return 1; } }',
  ])('%s', async source => {
    expect(await hits(PROBE, source)).toBe(1);
  });
});

describe('種類を決めない書き方は断らない', () => {
  it.each([
    "declare const error: { message: unknown }; export const a = typeof error.message === 'string';",
    "declare const message: string; export const a = message === '';",
    'declare const message: string | undefined; export const a = message !== undefined;',
    'declare const previous: string; declare const result: { message: string }; export const a = previous === result.message;',
    'declare const message: string; declare const error: Error; export const a = message.startsWith(error.name);',
    "declare const text: string; export const a = text.includes('x');",
  ])('%s', async source => {
    expect(await hits(PROBE, source)).toBe(0);
  });

  it('検査のファイルは見ない', async () => {
    expect(await hits('packages/model/src/part/messageKindProbe.test.ts', "declare const message: string; export const a = message.includes('x');")).toBe(0);
  });
});

describe('今ある所の表', () => {
  it('各行は、在るファイル・1 以上の数・区分・理由・直す予定を持ち、ファイルは重ならない', () => {
    expect(new Set(baseline.map(row => row.file)).size).toBe(baseline.length);
    for (const row of baseline) {
      expect(existsSync(resolve(root, row.file)), row.file).toBe(true);
      expect(Number.isInteger(row.count) && row.count >= 1, row.file).toBe(true);
      expect(KINDS.has(row.kind), row.file).toBe(true);
      expect(row.reason.length > 0 && row.plannedFix.length > 0, row.file).toBe(true);
      // 中の見分けは直す行。直す予定の束の名前(0b-…)を持つ。
      if (row.kind === 'internal') expect(row.plannedFix, row.file).toMatch(/^0b-\d/u);
    }
  });

  it('製品の全部のファイルの数が、表とファイルごとに一致する(増えても、直して減っても、表を合わせるまで落ちる)', () => {
    const linter = new Linter({ configType: 'flat', cwd: root });
    const config: Linter.Config[] = [{
      files: ['**/*.{ts,tsx,mts,cts}'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { 'failure-kind': { rules: { 'no-message-text-match': rule } } },
      rules: { [RULE]: ['error', { allowed: 0 }] },
    }];
    const roots = ['packages', 'apps'].flatMap(group => readdirSync(resolve(root, group), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(resolve(root, group, entry.name, 'src')))
      .map(entry => posix.join(group, entry.name, 'src')));
    const counted = new Map<string, number>();
    for (const file of roots.flatMap(directory => productFiles(root, directory))) {
      if (/\.(?:spec\.[cm]?tsx?|d\.[cm]?ts)$/u.test(file)) continue;
      const source = readFileSync(resolve(root, file), 'utf8');
      if (!source.includes('message')) continue;
      const messages = linter.verify(source, config, { filename: resolve(root, file) });
      expect(messages.filter(message => message.fatal), file).toEqual([]);
      const count = messages.filter(message => message.ruleId === RULE).length;
      if (count > 0) counted.set(file, count);
    }
    expect(Object.fromEntries([...counted].sort(([a], [b]) => a.localeCompare(b))))
      .toEqual(Object.fromEntries(baseline.map(row => [row.file, row.count] as const).sort(([a], [b]) => a.localeCompare(b))));
  });
});

const TEXT_PROBE = 'packages/ui/src/solid/failureTextProbe.ts';

describe('失敗の文(欄 text)の鍵を画面の一覧を通さずに持ち出す書き方は断る', () => {
  it.each([
    'declare const error: { text: { key: string } }; export const a = error.text.key;',
    'declare const error: { text?: { key: string } }; export const a = error.text?.key;',
    "declare const error: { text: { key: string } }; export const a = error.text['key'];",
    'declare const error: { text: { key: string } }; export const a = `${error.text.key}`;',
    'declare const error: { text: { key: string } }; const { key } = error.text; export const a = key;',
    'declare const error: { text: object }; export const a = JSON.stringify(error.text);',
    'declare const error: { text?: { parameters: object } }; export const a = JSON.stringify(error.text?.parameters);',
    'declare const errors: { text: object }[]; export const a = JSON.stringify(errors[0]!.text, null, 2);',
    'declare const row: { text: { parameters: object } }; export const a = JSON.stringify(row.text.parameters);',
    'declare const built: { rejection?: { text: object } }; export const a = JSON.stringify(built.rejection?.text);',
  ])('%s', async source => {
    expect(await hits(TEXT_PROBE, source, TEXT_RULE)).toBe(1);
  });
});

describe('鍵を一覧で文にする書き方・文字の欄 text(注記・文字の形・DXF の文字・状態の文)は断らない', () => {
  it.each([
    'declare function failureMessage(text: unknown): string; declare const error: { text: object }; export const a = failureMessage(error.text);',
    'declare const text: { key: string }; export const a = text.key;',
    'declare const row: { key: string; text: string }; export const a = row.key + row.text;',
    'declare const error: { text: object }; export const copy = { ...error, text: error.text };',
    'declare const label: { text: string }; export const a = label.text.length;',
    'declare const error: object; export const a = JSON.stringify(error);',
    'declare const note: { text: string }; export const a = JSON.stringify(note.text);',
    'declare const feature: { text: string }; export const a = JSON.stringify(feature.text);',
    'declare const entity: { text: string; height: number }; export const a = JSON.stringify(entity.text);',
    'declare const status: { text: string; failed: boolean }; export const a = JSON.stringify(status.text);',
    'declare const symbol: { text: string }; export const a = JSON.stringify(symbol.text.length);',
  ])('%s', async source => {
    expect(await hits(TEXT_PROBE, source, TEXT_RULE)).toBe(0);
  });

  it('検査のファイルは見ない', async () => {
    expect(await hits('packages/ui/src/solid/failureTextProbe.test.ts',
      'declare const error: { text: { key: string } }; export const a = error.text.key;', TEXT_RULE)).toBe(0);
  });

  it('製品の全部のファイルで当たりが 0(今ある所は無い)', () => {
    const linter = new Linter({ configType: 'flat', cwd: root });
    const config: Linter.Config[] = [{
      files: ['**/*.{ts,tsx,mts,cts}'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { 'failure-text': { rules: { 'no-key-as-text': textRule } } },
      rules: { [TEXT_RULE]: 'error' },
    }];
    const roots = ['packages', 'apps'].flatMap(group => readdirSync(resolve(root, group), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(resolve(root, group, entry.name, 'src')))
      .map(entry => posix.join(group, entry.name, 'src')));
    const counted: string[] = [];
    for (const file of roots.flatMap(directory => productFiles(root, directory))) {
      if (/\.(?:spec\.[cm]?tsx?|d\.[cm]?ts)$/u.test(file)) continue;
      const source = readFileSync(resolve(root, file), 'utf8');
      if (!source.includes('.text') && !source.includes('text?.')) continue;
      const messages = linter.verify(source, config, { filename: resolve(root, file) });
      expect(messages.filter(message => message.fatal), file).toEqual([]);
      for (const message of messages.filter(item => item.ruleId === TEXT_RULE)) counted.push(`${file}:${String(message.line)}`);
    }
    expect(counted).toEqual([]);
  });
});
