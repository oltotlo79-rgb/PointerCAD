/**
 * K-28 束 2: ねじ込み式管継手(JIS B 2301)のキャップ・プラグ・六角ニップル・ブッシングの族を、照らす側の読み
 * (pipeFittingPartOracle.fixture.json。2 つ目の出どころのカタログの表と継手の端部の表のおねじ部の長さだけから作った値)と突き合わせ、
 * 形と体積を確かめる。印 ※ は JIS B 2301 に無い品(入れない)、□・△ は JIS の品。資料の番号・URL・発行元は担当の資料の記録だけに置く。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { findPipeThread } from '../../../thread/pipeThread.js';
import { PIPE_FITTING_PART_FAMILIES } from './pipeFittingParts.js';

type Cells = readonly string[];
interface Table { readonly columns: Cells; readonly rows: readonly Cells[] }
interface Fixture {
  readonly caps: Table; readonly plugs: Table; readonly nipples: Table; readonly bushings: Table; readonly maleThreadLength: Table;
}

const isCells = (value: unknown): value is Cells => Array.isArray(value) && value.every((cell: unknown) => typeof cell === 'string');
const isTable = (value: unknown): value is Table => typeof value === 'object' && value !== null && 'columns' in value && 'rows' in value
  && isCells(value.columns) && Array.isArray(value.rows) && value.rows.every(isCells);

function readFixture(): Fixture {
  const value: unknown = JSON.parse(readFileSync(new URL('./pipeFittingPartOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null || !('caps' in value) || !('plugs' in value) || !('nipples' in value)
    || !('bushings' in value) || !('maleThreadLength' in value) || !isTable(value.caps) || !isTable(value.plugs) || !isTable(value.nipples)
    || !isTable(value.bushings) || !isTable(value.maleThreadLength)) throw new Error('fixture の形が違う');
  return { caps: value.caps, plugs: value.plugs, nipples: value.nipples, bushings: value.bushings, maleThreadLength: value.maleThreadLength };
}

const FIXTURE = readFixture();
const THREAD_OF_PIPE = new Map([[6, '1/8'], [8, '1/4'], [10, '3/8'], [15, '1/2'], [20, '3/4'], [25, '1'], [32, '1 1/4'], [40, '1 1/2'],
  [50, '2'], [65, '2 1/2'], [80, '3'], [100, '4'], [125, '5'], [150, '6']]);
const MALE_LENGTH = new Map(FIXTURE.maleThreadLength.rows.map(([size, length]) => [size, Number(length)]));
const major = (thread: string): number | undefined => findPipeThread('taper', thread)?.majorDiameter;
const minor = (thread: string): number | undefined => findPipeThread('taper', thread)?.minorDiameter;

describe('K-28 束 2 のキャップ・プラグ・ニップル・ブッシングの族と 2 つ目の出どころ', () => {
  it('キャップは 1/4〜6 の 13 行で、高さが照らす側と一致する(1/8 は 1 つの資料にしか無いので持たない)', () => {
    const family = PIPE_FITTING_PART_FAMILIES.cap;
    const expected = FIXTURE.caps.rows.filter(([size]) => size !== '1/8');
    expect(family.rows.map((row) => row.size)).toEqual(expected.map(([size, a]) => `${a ?? ''}A (Rc${size ?? ''})`));
    expect(family.rows.map((row) => row.dims.height)).toEqual(expected.map(([, , height]) => Number(height)));
    expect(family.rows.map((row) => row.dims.boreDiameter)).toEqual(expected.map(([size]) => minor(size ?? '')));
  });

  it('プラグは 1/2〜6 の 11 行で、頭の二面幅・高さとおねじ部の長さが照らす側と一致する', () => {
    const family = PIPE_FITTING_PART_FAMILIES.plug;
    expect(family.rows.map((row) => row.size)).toEqual(FIXTURE.plugs.rows.map(([size, a]) => `${a ?? ''}A (R${size ?? ''})`));
    expect(family.rows.map((row) => [row.dims.acrossFlats, row.dims.headHeight, row.dims.threadLength, row.dims.threadDiameter]))
      .toEqual(FIXTURE.plugs.rows.map(([size, , across, height]) => [Number(across), Number(height), MALE_LENGTH.get(size ?? ''),
        major(size ?? '')]));
  });

  it('六角ニップルは 1/8〜6 の 14 行で、二面幅・角の数・長さ・おねじの長さが照らす側と一致する', () => {
    const family = PIPE_FITTING_PART_FAMILIES.nipple;
    expect(family.rows.map((row) => row.size)).toEqual(FIXTURE.nipples.rows.map(([size, a]) => `${a ?? ''}A (R${size ?? ''})`));
    expect(family.rows.map((row) => [row.dims.acrossFlats, row.dims.sides, row.dims.overallLength, row.dims.threadLength]))
      .toEqual(FIXTURE.nipples.rows.map(([, , across, sides, length, male]) => [Number(across), Number(sides), Number(length), Number(male)]));
  });

  it('ブッシングは JIS の 58 組で、照らす側の ※ の無い組から 1 つの資料にしか無い 2 組を除いた物と、二面幅・長さ・おねじの長さが一致する', () => {
    const family = PIPE_FITTING_PART_FAMILIES.bushing;
    const onlyOneSource = new Set(['150x25', '150x40']);
    const expected = FIXTURE.bushings.rows.filter(([outer, inner, , , , marks]) => !(marks ?? '').includes('※')
      && !onlyOneSource.has(`${outer ?? ''}x${inner ?? ''}`));
    expect(family.rows).toHaveLength(58);
    expect(family.rows.map((row) => row.key)).toEqual(expected.map(([outer, inner]) => `bushing-${outer ?? ''}x${inner ?? ''}A`));
    expect(family.rows.map((row) => [row.dims.acrossFlats, row.dims.overallLength, row.dims.threadLength]))
      .toEqual(expected.map(([, , across, length, male]) => [Number(across), Number(length), Number(male)]));
    for (const row of family.rows) {
      const outer = THREAD_OF_PIPE.get(row.dims.pipeSize ?? NaN) ?? '', inner = THREAD_OF_PIPE.get(row.dims.innerPipeSize ?? NaN) ?? '';
      expect(row.size).toBe(`${String(row.dims.pipeSize)}A×${String(row.dims.innerPipeSize)}A (R${outer}×Rc${inner})`);
      expect([row.dims.threadDiameter, row.dims.boreDiameter, row.dims.sides]).toEqual([major(outer), minor(inner), (row.dims.pipeSize ?? 0) >= 50 ? 8 : 6]);
    }
  });

  it('出どころは JIS の番号だけ、族の版は凍結、質量の材質を持たず、形は簡略で体積は台本の式', () => {
    const solids = { cap: 3, plug: 3, nipple: 5, bushing: 5 } as const;
    const labels = { cap: 'キャップ', plug: 'プラグ', nipple: '六角ニップル', bushing: 'ブッシング' } as const;
    for (const kind of ['cap', 'plug', 'nipple', 'bushing'] as const) {
      const family = PIPE_FITTING_PART_FAMILIES[kind];
      expect([family.id, family.group, family.catalogRevision, family.generatorRevision, family.stock])
        .toEqual([`pipe-fitting-${kind}`, 'piping', `pipe-fitting-${kind}-2026-11-r1`, 'pipe-fitting-part-1', 'count']);
      for (const row of family.rows) {
        expect([row.evidence.reference, row.standardLabel, row.densityMaterialId]).toEqual(['JIS B 2301', 'JIS B 2301', undefined]);
        expect([row.evidence.title, row.evidence.locator].every((text) => !text.includes('資料'))).toBe(true);
        expect(row.simplified?.length).toBe(1);
        const part = family.build(row, {});
        expect(part?.name).toBe(`${labels[kind]} ${row.size}`);
        expect(part?.solids.length).toBe(solids[kind]);
        const volume = family.nominalVolume(row, {});
        expect(volume !== null && volume > 0).toBe(true);
      }
    }
  });

  it('体積の式: キャップ 25A は円柱 − 穴、ブッシング 25A×15A は六角の柱 + おねじ − 全長の穴', () => {
    const cap = PIPE_FITTING_PART_FAMILIES.cap.rows.find((row) => row.key === 'cap-25A');
    const bushing = PIPE_FITTING_PART_FAMILIES.bushing.rows.find((row) => row.key === 'bushing-25x15A');
    if (cap === undefined || bushing === undefined) throw new Error('行が無い');
    const circle = (diameter: number): number => Math.PI * (diameter / 2) ** 2;
    expect(PIPE_FITTING_PART_FAMILIES.cap.nominalVolume(cap, {})).toBeCloseTo(circle(41) * 28 - circle(30.291) * 15, 6);
    const hexagon = 6 * 19 ** 2 * Math.tan(Math.PI / 6);
    expect(PIPE_FITTING_PART_FAMILIES.bushing.nominalVolume(bushing, {}))
      .toBeCloseTo(hexagon * (27 - 20) + circle(33.249) * 20 - circle(18.631) * 27, 6);
  });
});
