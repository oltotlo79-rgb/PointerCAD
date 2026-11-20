/**
 * K-28 束 1・束 2: ねじ込み式管継手(JIS B 2301)のエルボ・チーズ・ソケットの族と管用ねじ(JIS B 0203・JIS B 0202)の表を、照らす側の読み
 * (pipeFittingOracle.fixture.json。2 つ目の出どころの表だけから作った値)と突き合わせ、形と体積を確かめる。
 * - threadTable: 管用テーパねじの表(1/16〜1 1/2 の全部の欄)。endTable: 継手の端部の寸法の表(1/8〜6)。catalog: 継手のカタログの表(1/8〜6)。
 * - parallelThreadTable: 管用平行ねじの表(1/16〜6 の 24 の呼び。1/16 は製品に入れない)。
 * 資料の番号・URL・発行元は担当の資料の記録だけに置く。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { findPipeThread } from '../../../thread/pipeThread.js';
import { PIPE_FITTING_FAMILIES } from './pipeFittings.js';

type Cells = readonly string[];
interface Table { readonly columns: Cells; readonly rows: readonly Cells[] }
interface Fixture { readonly threadTable: Table; readonly endTable: Table; readonly catalog: Table; readonly parallelThreadTable: Table }

const isCells = (value: unknown): value is Cells => Array.isArray(value) && value.every((cell: unknown) => typeof cell === 'string');
const isTable = (value: unknown): value is Table => typeof value === 'object' && value !== null && 'columns' in value && 'rows' in value
  && isCells(value.columns) && Array.isArray(value.rows) && value.rows.every(isCells);

function readFixture(): Fixture {
  const value: unknown = JSON.parse(readFileSync(new URL('./pipeFittingOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null || !('threadTable' in value) || !('endTable' in value) || !('catalog' in value)
    || !('parallelThreadTable' in value) || !isTable(value.threadTable) || !isTable(value.endTable) || !isTable(value.catalog)
    || !isTable(value.parallelThreadTable)) throw new Error('fixture の形が違う');
  return { threadTable: value.threadTable, endTable: value.endTable, catalog: value.catalog, parallelThreadTable: value.parallelThreadTable };
}

const FIXTURE = readFixture();
const SIZES = ['1/8', '1/4', '3/8', '1/2', '3/4', '1', '1 1/4', '1 1/2', '2', '2 1/2', '3', '4', '5', '6'];
const numbers = (cells: Cells): number[] => cells.map(Number);
const columnsOf = (thread: NonNullable<ReturnType<typeof findPipeThread>>): number[] => [thread.threadsPerInch, thread.pitch, thread.height,
  thread.roundness, thread.majorDiameter, thread.pitchDiameter, thread.minorDiameter];

describe('K-28 管用ねじの表と 2 つ目の出どころ', () => {
  it('テーパねじの 1/16〜1 1/2 は全部の欄が、表の資料と一致する', () => {
    expect(FIXTURE.threadTable.rows).toHaveLength(9);
    for (const [size, ...cells] of FIXTURE.threadTable.rows) {
      const thread = size === undefined ? undefined : findPipeThread('taper', size);
      expect(thread === undefined ? [] : [...columnsOf(thread), thread.gaugeLength], size).toEqual(numbers(cells));
    }
  });

  it('テーパねじの 1/8〜6 の基準径・山数・基準の長さ a は、継手の端部の表と一致する', () => {
    expect(FIXTURE.endTable.rows.map(([size]) => size)).toEqual(SIZES);
    for (const [size, d, tpi, , , , a] of FIXTURE.endTable.rows) {
      const thread = findPipeThread('taper', size ?? '');
      expect([thread?.majorDiameter, thread?.threadsPerInch, thread?.gaugeLength], size).toEqual([Number(d), Number(tpi), Number(a)]);
    }
  });

  it('平行ねじは 1/8〜6 の 23 の呼びの全部の欄が表の資料と一致し、1 つの資料にしか無い 1/16 は持たない', () => {
    const rows = FIXTURE.parallelThreadTable.rows;
    expect(rows).toHaveLength(24);
    expect(findPipeThread('parallel', '1/16')).toBeUndefined();
    for (const [size, ...cells] of rows.filter(([size]) => size !== '1/16')) {
      const thread = findPipeThread('parallel', size ?? '');
      expect(thread === undefined ? [] : [...columnsOf(thread), thread.gaugeLength], size).toEqual([...numbers(cells), null]);
    }
  });
});

describe('K-28 ねじ込み式管継手の族と 2 つ目の出どころ', () => {
  it('3 族とも 1/8〜6 の 14 行で、呼び A・B、中心から端面まで(ソケットは長さ)、腕の外径、めねじ部の長さが照らす側と一致する', () => {
    const end = new Map(FIXTURE.endTable.rows.map(([size, , , female, outer]) => [size, [Number(outer), Number(female)]]));
    for (const [kind, column] of [['elbow', 2], ['tee', 3], ['socket', 4]] as const) {
      const family = PIPE_FITTING_FAMILIES[kind];
      expect(family.rows.map((row) => row.size)).toEqual(FIXTURE.catalog.rows.map(([a, b]) => `${a ?? ''}A (Rc${b ?? ''})`));
      expect(family.rows.map((row) => [row.dims.pipeSize, row.dims.length])).toEqual(FIXTURE.catalog.rows.map((cells) => [Number(cells[0]), Number(cells[column])]));
      expect(family.rows.map((row) => [row.dims.outerDiameter, row.dims.femaleThreadLength]))
        .toEqual(FIXTURE.catalog.rows.map(([, b]) => end.get(b ?? '') ?? []));
    }
  });

  it('穴の径は管用テーパねじの谷の径、出どころは JIS の番号だけ、族の版は凍結、形は簡略で体積は台本の式', () => {
    for (const [kind, label] of [['elbow', 'エルボ'], ['tee', 'チーズ'], ['socket', 'ソケット']] as const) {
      const family = PIPE_FITTING_FAMILIES[kind];
      expect([family.id, family.group, family.catalogRevision, family.generatorRevision])
        .toEqual([`pipe-fitting-${kind}`, 'piping', `pipe-fitting-${kind}-2026-11-r1`, 'pipe-fitting-1']);
      for (const [index, row] of family.rows.entries()) {
        expect(row.dims.boreDiameter).toBe(findPipeThread('taper', SIZES[index] ?? '')?.minorDiameter);
        expect(row.evidence.reference).toBe('JIS B 2301');
        expect([row.evidence.title, row.evidence.locator].every((text) => !text.includes('資料'))).toBe(true);
        expect(row.densityMaterialId).toBeUndefined();
        const part = family.build(row, {});
        expect(part?.name).toBe(`${label} ${row.size}`);
        expect(part?.solids.length).toBe(kind === 'socket' ? 3 : kind === 'elbow' ? 9 : 13);
        const volume = family.nominalVolume(row, {});
        expect(volume !== null && volume > 0).toBe(true);
      }
    }
  });
});
