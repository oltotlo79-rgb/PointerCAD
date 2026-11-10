import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareBaseline, FUNCTION_SIZE_OPTIONS, FUNCTION_SIZE_RULE, functionSizeConfig, measureFunctions,
  type BaselineEntry } from './functionSizePolicy.testSupport.js';

type BaselineRow = Parameters<typeof compareBaseline>[0];

// Review E09: every product function is capped at 200 ESLint lines; each grandfathered function keeps its own
// measured count (eslint.functionSizeBaseline.js), so a smaller one cannot grow behind the largest in its file.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const NO_DRIFT = { grown: [], stale: [], unlisted: [], obsolete: [], ambiguous: [], duplicateRows: [], withinCap: [] };
const PRODUCT_SOURCE = /^(?:packages|apps)\/[^/]+\/src\/.+\.tsx?$/u;
const TEST_SOURCE = /\.(?:test|testSupport|spec)\.tsx?$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEntry(value: unknown): value is BaselineEntry {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

async function loadPolicy(): Promise<{ readonly cap: number; readonly rows: readonly BaselineRow[] }> {
  const loaded: unknown = await import(new URL('../../../eslint.functionSizeBaseline.js', import.meta.url).href);
  if (!record(loaded)) throw new Error('eslint.functionSizeBaseline.js did not load');
  const loadedCap: unknown = loaded.FUNCTION_SIZE_CAP;
  const baseline: unknown = loaded.FUNCTION_SIZE_BASELINE;
  if (typeof loadedCap !== 'number' || !Array.isArray(baseline)) {
    throw new Error('eslint.functionSizeBaseline.js must export FUNCTION_SIZE_CAP and FUNCTION_SIZE_BASELINE');
  }
  const list: readonly unknown[] = baseline;
  return { cap: loadedCap, rows: list.map((row) => {
    if (!record(row)) throw new Error('Malformed row');
    const file: unknown = row.file;
    const entries: unknown = row.functions;
    if (typeof file !== 'string' || !Array.isArray(entries)) throw new Error('Malformed row');
    const functions: readonly unknown[] = entries;
    if (!functions.every(isEntry)) throw new Error(`Malformed functions: ${file}`);
    return { file, functions: functions.filter(isEntry) };
  }) };
}

const { cap, rows } = await loadPolicy();
const parser = tseslint.parser;
let eslint: ESLint;
beforeAll(() => { eslint = new ESLint({ cwd: root }); });

/** The merged project setting for one path, accepted only as an enforced rule with ESLint's skip options. */
async function effectiveMax(path: string): Promise<number | undefined> {
  const config: unknown = await eslint.calculateConfigForFile(path);
  if (!record(config) || !record(config.rules)) throw new Error(`Missing configuration: ${path}`);
  const setting: unknown = config.rules[FUNCTION_SIZE_RULE];
  if (setting === undefined) return undefined;
  if (!Array.isArray(setting)) throw new Error(`${FUNCTION_SIZE_RULE} is not configured as an array: ${path}`);
  const parts: readonly unknown[] = setting;
  if (parts.length !== 2 || (parts[0] !== 2 && parts[0] !== 'error')) {
    throw new Error(`${FUNCTION_SIZE_RULE} is not enforced: ${path}`);
  }
  const options: unknown = parts[1];
  if (!record(options) || typeof options.max !== 'number') throw new Error(`Malformed options: ${path}`);
  expect(options, path).toEqual({ max: options.max, ...FUNCTION_SIZE_OPTIONS });
  return options.max;
}

/** A function ESLint counts as exactly `lines` lines, padded with a blank and a comment line that it skips. */
function syntheticFunction(name: string, lines: number): string {
  const body = Array.from({ length: lines - 4 }, (_, index) => `  total += ${index};`);
  return [`export function ${name}(): number {`, '  let total = 0;', ...body, '', '  // skipped', '  return total;', '}']
    .join('\n');
}

function sizeReports(path: string, max: number, source: string): Linter.LintMessage[] {
  const messages = new Linter().verify(source, [functionSizeConfig(parser, max)], { filename: path });
  expect(messages.some(message => message.fatal), path).toBe(false);
  return messages.filter(message => message.ruleId === FUNCTION_SIZE_RULE);
}

function largest(row: BaselineRow): number {
  return Math.max(...row.functions.map(([, lines]) => lines));
}

// The existing narrower caps in eslint.config.js, copied from its literals (not computed from the config).
const strictCaps: [path: string, max: number][] = [
  ['packages/model/src/kernelBridge/subShapeMatching.ts', 100], ['packages/ui/src/sketch/numericInputTools.ts', 30],
  ['packages/ui/src/appearance/appearancePropertyValues.ts', 50], ['packages/ui/src/sketch/numericFieldUnits.ts', 50],
  ['packages/ui/src/solid/measureFormatting.ts', 50], ['packages/ui/src/sketch/numericInputPresentation.ts', 50],
  ['packages/ui/src/sketch/numericInputChoices.ts', 120], ['packages/ui/src/sketch/numericInputEvaluation.ts', 50],
  ['packages/ui/src/sketch/twoPointArcInput.ts', 40], ['packages/ui/src/sketch/splineInputDraft.ts', 40],
  ['packages/io/src/pcad/documentJson.ts', 200], ['packages/io/src/pcad/codecs/solidHoles.test.ts', 200],
  ['packages/ui/src/solid/referenceSummary.ts', 200], ['packages/model/src/part/solidSketchReferences.ts', 200],
];

const capped = [
  'packages/model/src/index.ts', 'packages/ui/src/index.ts', 'packages/kernel/src/index.ts',
  'packages/expression/src/index.ts', 'packages/drawing/src/index.ts', 'packages/io/src/index.ts',
  'packages/fem/src/index.ts', 'packages/help-content/src/index.ts', 'packages/test-utils/src/perfBudget.ts',
  'apps/web/src/helpChunkPolicy.ts', 'apps/desktop/src/main/occtHttpTransport.ts',
  // Formerly 300 or 260 per function; now the product cap.
  'packages/ui/src/appearance/AppearanceMenu.tsx', 'packages/ui/src/shell/propertySectionText.ts',
  'packages/model/src/part/solidPlanKeyGeometry.ts',
];

describe('関数ごとの上限の表は実在する製品の超過関数だけを持つ', () => {
  it('上限は200で、行は重複せず、検査用・厳しい上限のファイルを含まない', () => {
    expect(cap).toBe(200);
    expect(rows.length).toBeGreaterThan(0);
    const files = rows.map(row => row.file);
    expect(new Set(files).size).toBe(files.length);
    for (const row of rows) {
      expect(PRODUCT_SOURCE.test(row.file) && !TEST_SOURCE.test(row.file), row.file).toBe(true);
      expect(existsSync(new URL(row.file, new URL('../../../', import.meta.url))), row.file).toBe(true);
      expect(row.functions.length, row.file).toBeGreaterThan(0);
    }
    const strictFiles = new Set(strictCaps.map(([path]) => path));
    expect(files.filter(file => strictFiles.has(file) || capped.includes(file))).toEqual([]);
  });
});

describe('既存の長い関数はそれぞれ自身の実測値を超えられない', () => {
  it.each(rows.map((row): [string, BaselineRow] => [row.file, row]))('%s', async (file, row) => {
    const source = readFileSync(new URL(file, new URL('../../../', import.meta.url)), 'utf8');
    const measured = measureFunctions(new Linter(), parser, file, source, cap);
    // Grown, shrunk-but-not-lowered, new over-cap, vanished, ambiguous, duplicated and within-cap rows all fail.
    expect(compareBaseline(row, measured, cap)).toEqual(NO_DRIFT);
    const max = largest(row);
    expect(await effectiveMax(file)).toBe(max);
    expect(sizeReports(file, max, syntheticFunction('atLimit', max))).toEqual([]);
    expect(sizeReports(file, max, syntheticFunction('overLimit', max + 1))).toHaveLength(1);
  });
});

describe('同じファイルの最大でない長い関数が1行増えても拒否する', () => {
  const file = 'packages/model/src/e09Synthetic.ts';
  const row: BaselineRow = { file, functions: [['large', 260], ['smaller', 230]] };
  const source = (smaller: number, extra = '') =>
    `${syntheticFunction('large', 260)}\n${syntheticFunction('smaller', smaller)}\n${extra}`;
  const drift = (text: string, baseline: BaselineRow = row) =>
    compareBaseline(baseline, measureFunctions(new Linter(), parser, file, text, cap), cap);

  it('ファイル最大の上限だけでは見逃す増加を関数ごとの値で検出する', () => {
    expect(sizeReports(file, largest(row), source(231))).toEqual([]);
    expect(drift(source(230))).toEqual(NO_DRIFT);
    expect(drift(source(231))).toEqual({ ...NO_DRIFT, grown: ['smaller'] });
  });

  it('縮めた関数の古い値・消えた関数・一覧外の超過・識別できない重複・過剰な行を拒否する', () => {
    expect(drift(source(229))).toEqual({ ...NO_DRIFT, stale: ['smaller'] });
    expect(drift(source(200))).toEqual({ ...NO_DRIFT, obsolete: ['smaller'] });
    expect(drift(source(230, syntheticFunction('extra', 201)))).toEqual({ ...NO_DRIFT, unlisted: ['extra'] });
    const twice = (name: string) => `export const ${name} = [{ run() {\n${'  void 0;\n'.repeat(210)}} }, { run() {\n${
      '  void 0;\n'.repeat(210)}} }];`;
    expect(drift(twice('tasks'), { file, functions: [['tasks::run', 212]] }).ambiguous).toEqual(['tasks::run']);
    expect(drift(source(230), { file, functions: [['large', 260], ['smaller', 230], ['smaller', 230]] }).duplicateRows)
      .toEqual(['smaller']);
    expect(drift(source(230), { file, functions: [['large', 260], ['smaller', 230], ['small', 200]] }))
      .toEqual({ ...NO_DRIFT, obsolete: ['small'], withinCap: ['small'] });
  });

  it('実物のファイルでも最大でない関数への1行の追加を拒否する', () => {
    const passedPerFileLint: string[] = [];
    for (const real of rows.filter(entry => entry.functions.length > 1)) {
      const text = readFileSync(new URL(real.file, new URL('../../../', import.meta.url)), 'utf8');
      const measured = measureFunctions(new Linter(), parser, real.file, text, cap);
      for (const target of measured.functions.filter(entry => entry.lines < largest(real))) {
        if (target.bodyStart === undefined) continue;
        const grown = `${text.slice(0, target.bodyStart)}\nvoid 0;${text.slice(target.bodyStart)}`;
        const result = compareBaseline(real, measureFunctions(new Linter(), parser, real.file, grown, cap), cap);
        expect(result.grown, `${real.file} ${target.id}`).toContain(target.id);
        if (sizeReports(real.file, largest(real), grown).length === 0) passedPerFileLint.push(target.id);
      }
    }
    // At least one real smaller function grows unnoticed by the per-file maximum alone.
    expect(passedPerFileLint.length).toBeGreaterThan(0);
  });
});

describe('製品の関数は200行まで、既存の厳しい上限は弱めない', () => {
  it.each(capped)('%s: 200行は通り201行は拒否する', async path => {
    expect(await effectiveMax(path)).toBe(cap);
    expect(sizeReports(path, cap, syntheticFunction('atCap', cap))).toEqual([]);
    const over = sizeReports(path, cap, syntheticFunction('overCap', cap + 1));
    expect(over).toHaveLength(1);
    expect(over[0]?.message).toContain(`(${cap + 1})`);
  });

  it.each(strictCaps)('%s は %i 行のまま', async (path, max) => {
    expect(await effectiveMax(path)).toBe(max);
    expect(sizeReports(path, max, syntheticFunction('atStrictCap', max))).toEqual([]);
    expect(sizeReports(path, max, syntheticFunction('overStrictCap', max + 1))).toHaveLength(1);
  });

  it('検査と検査用の補助は製品の上限の対象外', async () => {
    for (const path of ['packages/model/src/part/createPartDocument.test.ts',
      'packages/test-utils/src/packageImportBoundary.testSupport.ts', 'packages/test-utils/src/functionSizePolicy.test.ts']) {
      expect(await effectiveMax(path), path).toBeUndefined();
    }
  });
});
