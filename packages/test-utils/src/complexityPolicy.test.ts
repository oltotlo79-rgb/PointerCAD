import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareComplexity, complexityConfig, DEPTH_RULE, measureDepth, measureParams, MODULE_SCOPE, PARAMS_RULE,
  type ComplexityEntry, type ComplexityRow, type MeasuredComplexity } from './complexityPolicy.testSupport.js';

// Code rule P06: product functions take at most PARAMS_CAP parameters and nest blocks at most DEPTH_CAP deep, in
// the same scope as the E09 function-size rule. Each grandfathered function keeps its own measured value
// (eslint.complexityBaseline.js), so a smaller one cannot grow behind the largest in its file.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const NO_DRIFT = { grown: [], stale: [], unlisted: [], obsolete: [], ambiguous: [], duplicateRows: [], withinCap: [],
  malformed: [] };
const PRODUCT_SOURCE = /^(?:packages|apps)\/[^/]+\/src\/.+\.tsx?$/u;
const TEST_SOURCE = /\.(?:test|testSupport|spec)\.tsx?$/u;
// Frozen with the measured baseline (2026-11-03, 2,013 product files); a row or function added later must also
// raise these in review. Removing rows (shrunk functions) only lowers the counts.
const CEILING = { params: { files: 72, functions: 101 }, depth: { files: 34, functions: 39 } } as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function entryOf(width: number) {
  return (value: unknown): value is ComplexityEntry => Array.isArray(value) && value.length === width + 1
    && typeof value[0] === 'string' && value.slice(1).every(item => typeof item === 'number');
}

function rowsOf(baseline: unknown, width: number): ComplexityRow[] {
  if (!Array.isArray(baseline)) throw new Error('Baseline must be an array');
  const list: readonly unknown[] = baseline;
  const isEntry = entryOf(width);
  return list.map((row) => {
    if (!record(row)) throw new Error('Malformed row');
    const file: unknown = row.file;
    const entries: unknown = row.functions;
    if (typeof file !== 'string' || !Array.isArray(entries)) throw new Error('Malformed row');
    const functions: readonly unknown[] = entries;
    if (!functions.every(isEntry)) throw new Error(`Malformed functions: ${file}`);
    return { file, functions: functions.filter(isEntry) };
  });
}

async function loadPolicy() {
  const loaded: unknown = await import(new URL('../../../eslint.complexityBaseline.js', import.meta.url).href);
  if (!record(loaded)) throw new Error('eslint.complexityBaseline.js did not load');
  const { PARAMS_CAP: params, DEPTH_CAP: depth } = loaded;
  if (typeof params !== 'number' || typeof depth !== 'number') throw new Error('Caps must be numbers');
  return { params, depth, paramRows: rowsOf(loaded.PARAMS_BASELINE, 1), depthRows: rowsOf(loaded.DEPTH_BASELINE, 2) };
}

const { params: paramsCap, depth: depthCap, paramRows, depthRows } = await loadPolicy();
const parser = tseslint.parser;
let eslint: ESLint;
beforeAll(() => { eslint = new ESLint({ cwd: root }); });

interface Kind {
  readonly rule: string;
  readonly cap: number;
  readonly width: number;
  readonly rows: readonly ComplexityRow[];
  readonly measure: (linter: Linter, tsParser: Linter.Parser, file: string, source: string, cap: number) =>
    MeasuredComplexity;
  /** A single function with exactly `value` parameters or nesting levels. */
  readonly synthetic: (name: string, value: number) => string;
}

function paramsFunction(name: string, count: number): string {
  const names = Array.from({ length: count }, (_, index) => `p${index}`);
  return `export function ${name}(${names.map(item => `${item}: number`).join(', ')}): number {\n  return ${
    names.join(' + ') || '0'};\n}\n`;
}

function depthFunction(name: string, depth: number): string {
  const open = Array.from({ length: depth }, (_, index) => `${'  '.repeat(index + 1)}if (flag) {`);
  const close = Array.from({ length: depth }, (_, index) => `${'  '.repeat(depth - index)}}`);
  return [`export function ${name}(flag: boolean): number {`, ...open, `${'  '.repeat(depth + 1)}return 1;`, ...close,
    '  return 0;', '}', ''].join('\n');
}

const kinds: readonly Kind[] = [
  { rule: PARAMS_RULE, cap: paramsCap, width: 1, rows: paramRows, measure: measureParams, synthetic: paramsFunction },
  { rule: DEPTH_RULE, cap: depthCap, width: 2, rows: depthRows, measure: measureDepth, synthetic: depthFunction },
];

/** The merged project setting for one path, accepted only as an enforced rule with a numeric max and no other option. */
async function effectiveMax(rule: string, path: string): Promise<number | undefined> {
  const config: unknown = await eslint.calculateConfigForFile(path);
  if (!record(config) || !record(config.rules)) throw new Error(`Missing configuration: ${path}`);
  const setting: unknown = config.rules[rule];
  if (setting === undefined) return undefined;
  if (!Array.isArray(setting)) throw new Error(`${rule} is not configured as an array: ${path}`);
  const parts: readonly unknown[] = setting;
  if (parts.length !== 2 || (parts[0] !== 2 && parts[0] !== 'error')) throw new Error(`${rule} is not enforced: ${path}`);
  const options: unknown = parts[1];
  if (!record(options) || typeof options.max !== 'number') throw new Error(`Malformed options: ${path}`);
  expect(options, path).toEqual({ max: options.max });
  return options.max;
}

function reports(rule: string, path: string, max: number, source: string): Linter.LintMessage[] {
  const messages = new Linter().verify(source, [complexityConfig(parser, rule, max)], { filename: path });
  expect(messages.some(message => message.fatal), path).toBe(false);
  return messages.filter(message => message.ruleId === rule);
}

function largest(row: ComplexityRow): number {
  return Math.max(...row.functions.map(([, value]) => value ?? 0));
}

// Product paths with no grandfathered row: the plain caps apply.
const capped = ['packages/model/src/index.ts', 'packages/ui/src/index.ts', 'packages/kernel/src/index.ts',
  'packages/expression/src/index.ts', 'apps/web/src/helpChunkPolicy.ts'];

describe('引数と入れ子の上限の表は実在する製品の超過関数だけを持つ', () => {
  it.each(kinds)('$rule: 上限は監査の提案値で、行は重複せず検査用のファイルを含まず、天井を超えない', (kind) => {
    expect(kind.cap).toBe(kind.rule === PARAMS_RULE ? 6 : 5);
    const files = kind.rows.map(row => row.file);
    expect(new Set(files).size).toBe(files.length);
    for (const row of kind.rows) {
      expect(PRODUCT_SOURCE.test(row.file) && !TEST_SOURCE.test(row.file), row.file).toBe(true);
      expect(existsSync(new URL(row.file, new URL('../../../', import.meta.url))), row.file).toBe(true);
      expect(row.functions.length, row.file).toBeGreaterThan(0);
    }
    const ceiling = kind.rule === PARAMS_RULE ? CEILING.params : CEILING.depth;
    expect(kind.rows.length).toBeLessThanOrEqual(ceiling.files);
    expect(kind.rows.reduce((total, row) => total + row.functions.length, 0)).toBeLessThanOrEqual(ceiling.functions);
    expect(files.filter(file => capped.includes(file))).toEqual([]);
  });
});

describe('既存の超過関数はそれぞれ自身の実測値を超えられない', () => {
  const cases = kinds.flatMap(kind => kind.rows.map((row): [string, string, Kind, ComplexityRow] =>
    [kind.rule, row.file, kind, row]));
  if (cases.length === 0) {
    it('表が空の間は照合する行も無い（Root の実測で埋めるまで）', () => { expect(cases).toEqual([]); });
  } else it.each(cases)('%s %s', async (_rule, file, kind, row) => {
    const source = readFileSync(new URL(file, new URL('../../../', import.meta.url)), 'utf8');
    const measured = kind.measure(new Linter(), parser, file, source, kind.cap);
    expect(compareComplexity(row, measured, kind.cap, kind.width)).toEqual(NO_DRIFT);
    const max = largest(row);
    expect(await effectiveMax(kind.rule, file)).toBe(max);
    expect(reports(kind.rule, file, max, kind.synthetic('atLimit', max))).toEqual([]);
    expect(reports(kind.rule, file, max, kind.synthetic('overLimit', max + 1))).toHaveLength(1);
  });
});

describe('製品の関数は引数6・入れ子5まで、検査と検査用の補助は対象外', () => {
  it.each(kinds.flatMap(kind => capped.map((path): [string, string, Kind] => [kind.rule, path, kind])))(
    '%s %s: 上限は通り、1つ多いと拒否する', async (_rule, path, kind) => {
      expect(await effectiveMax(kind.rule, path)).toBe(kind.cap);
      expect(reports(kind.rule, path, kind.cap, kind.synthetic('atCap', kind.cap))).toEqual([]);
      const over = reports(kind.rule, path, kind.cap, kind.synthetic('overCap', kind.cap + 1));
      expect(over).toHaveLength(1);
      expect(over[0]?.message).toContain(`(${kind.cap + 1})`);
    });

  it('引数は型の関数・宣言だけの関数も数え、this: void は数えない', () => {
    const path = 'packages/model/src/p06Synthetic.ts';
    const seven = Array.from({ length: 7 }, (_, index) => `p${index}: number`).join(', ');
    const six = Array.from({ length: 6 }, (_, index) => `p${index}: number`).join(', ');
    expect(reports(PARAMS_RULE, path, 6, `export type Wide = (${seven}) => void;\n`)).toHaveLength(1);
    expect(reports(PARAMS_RULE, path, 6, `export declare function wide(${seven}): void;\n`)).toHaveLength(1);
    expect(reports(PARAMS_RULE, path, 6, `export function bound(this: void, ${six}): void { void p0; }\n`)).toEqual([]);
    expect(measureParams(new Linter(), parser, path, `export type Wide = (${seven}) => void;\n`, 6).entries)
      .toEqual([['Wide', 7]]);
  });

  it('検査と検査用の補助には規則が付かない', async () => {
    for (const path of ['packages/model/src/part/createPartDocument.test.ts',
      'packages/test-utils/src/functionSizePolicy.testSupport.ts', 'packages/test-utils/src/complexityPolicy.test.ts']) {
      for (const kind of kinds) expect(await effectiveMax(kind.rule, path), `${kind.rule} ${path}`).toBeUndefined();
    }
  });
});

describe('同じファイルの最大でない超過関数の増加と、不要になった例外の残存を拒否する', () => {
  const file = 'packages/model/src/p06Synthetic.ts';
  const drift = (kind: Kind, row: ComplexityRow, text: string) =>
    compareComplexity(row, kind.measure(new Linter(), parser, file, text, kind.cap), kind.cap, kind.width);
  const [params, depth] = kinds;
  if (params === undefined || depth === undefined) throw new Error('Both kinds are required');

  it('引数: ファイル最大の上限だけでは見逃す増加を関数ごとの値で検出する', () => {
    const row: ComplexityRow = { file, functions: [['large', 10], ['smaller', 8]] };
    const source = (smaller: number, extra = '') =>
      `${paramsFunction('large', 10)}${paramsFunction('smaller', smaller)}${extra}`;
    expect(reports(PARAMS_RULE, file, largest(row), source(9))).toEqual([]);
    expect(drift(params, row, source(8))).toEqual(NO_DRIFT);
    expect(drift(params, row, source(9))).toEqual({ ...NO_DRIFT, grown: ['smaller'] });
    expect(drift(params, row, source(7))).toEqual({ ...NO_DRIFT, stale: ['smaller'] });
    expect(drift(params, row, source(6))).toEqual({ ...NO_DRIFT, obsolete: ['smaller'] });
    expect(drift(params, row, source(8, paramsFunction('extra', 7)))).toEqual({ ...NO_DRIFT, unlisted: ['extra'] });
    expect(drift(params, { file, functions: [['large', 10], ['smaller', 8], ['smaller', 8]] }, source(8)).duplicateRows)
      .toEqual(['smaller']);
    expect(drift(params, { file, functions: [['large', 10], ['smaller', 8], ['small', 6]] }, source(8)))
      .toEqual({ ...NO_DRIFT, obsolete: ['small'], withinCap: ['small'] });
    const seven = Array.from({ length: 7 }, (_, index) => `p${index}: number`).join(', ');
    const twice = `export const tasks = [{ run(${seven}) { return p6; } }, { run(${seven}) { return p6; } }];\n`;
    expect(drift(params, { file, functions: [['tasks::run', 7]] }, twice).ambiguous).toEqual(['tasks::run']);
  });

  it('入れ子: 最も深い段の増加と、同じ深さの超過ブロックの追加を検出する', () => {
    const row: ComplexityRow = { file, functions: [['large', 8, 3], ['smaller', 6, 1]] };
    const source = (smaller: number, extra = '') =>
      `${depthFunction('large', 8)}${depthFunction('smaller', smaller)}${extra}`;
    expect(drift(depth, row, source(6))).toEqual(NO_DRIFT);
    expect(reports(DEPTH_RULE, file, largest(row), source(7))).toEqual([]);
    expect(drift(depth, row, source(7))).toEqual({ ...NO_DRIFT, grown: ['smaller'] });
    // A second block at the same deepest level (6) keeps the maximum but adds one more over-cap block.
    const sibling = ['export function smaller(flag: boolean): number {',
      '  if (flag) { if (flag) { if (flag) { if (flag) { if (flag) {',
      '    if (flag) { return 1; }', '    if (flag) { return 2; }', '  } } } } }', '  return 0;', '}', ''].join('\n');
    expect(reports(DEPTH_RULE, file, 5, sibling)).toHaveLength(2);
    expect(drift(depth, row, `${depthFunction('large', 8)}${sibling}`)).toEqual({ ...NO_DRIFT, grown: ['smaller'] });
    expect(drift(depth, { file, functions: [['large', 8, 3], ['smaller', 6, 2]] }, source(6)))
      .toEqual({ ...NO_DRIFT, stale: ['smaller'] });
    expect(drift(depth, row, source(5))).toEqual({ ...NO_DRIFT, obsolete: ['smaller'] });
    expect(drift(depth, row, source(6, depthFunction('extra', 6)))).toEqual({ ...NO_DRIFT, unlisted: ['extra'] });
    expect(drift(depth, { file, functions: [['large', 8, 3], ['smaller', 6]] }, source(6)).malformed).toEqual(['smaller']);
    const moduleLevel = `let flag = true;\n${'if (flag) {\n'.repeat(6)}flag = false;\n${'}\n'.repeat(6)}`;
    expect(depth.measure(new Linter(), parser, file, moduleLevel, 5).entries).toEqual([[MODULE_SCOPE, 6, 1]]);
  });
});
