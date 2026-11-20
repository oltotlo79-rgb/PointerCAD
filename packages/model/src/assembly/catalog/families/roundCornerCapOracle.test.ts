/**
 * 1 つの角が大きな R のフレームに合う端のキャップの行(roundCornerCapRows.ts。38 回目の 2 本の読みで揃った値)の検査(14f)。
 * 照らす側の読み(roundCornerCapOracle.fixture.json。2 本目の外形の寸法線・頁・材質・質量の文字)を、この検査が自分で読み解く:
 * 横・縦・左上の外周円弧の R・厚さは記入のまま、材質の PA はナイロン、質量は 1 個の値。あわせて、合うフレームの行(外周の 4 つ目の頂点〔左上〕の半径)と
 * 外形と R が同じ事、族の行(形・体積・質量・合うフレームの鍵)を確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { frameCapProfile } from '../profiles/framePartShapes.js';
import { FRAME_CAP_FAMILY } from './framePartCatalog.js';
import { T_SLOT_OUTLINE_RECORDS } from './frameOutlineRows.js';
import { ROUND_CORNER_CAP_RECORDS } from './roundCornerCapRows.js';

interface FixtureRow {
  readonly key: string; readonly frameKey: string; readonly page: string; readonly outline: string; readonly material: string; readonly mass: string;
}

const FIELDS = ['key', 'frameKey', 'page', 'outline', 'material', 'mass'] as const;
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null
  && FIELDS.every((field) => typeof Object.getOwnPropertyDescriptor(value, field)?.value === 'string');

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./roundCornerCapOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();

/** 「横: 20(…) / 縦: 20(…) / R15(左上の外周円弧); 3-R1(…) / 厚さ: 3(…)」→ 横・縦・左上の R・厚さ。 */
function outlineOf(text: string): readonly number[] {
  const value = text.replace(/\s+/gu, '');
  const first = (pattern: RegExp): number => Number(pattern.exec(value)?.[1] ?? NaN);
  const large = [...value.matchAll(/(?<![0-9-])R([0-9]+(?:\.[0-9]+)?)\(([^()]*)\)/gu)].filter((match) => (match[2] ?? '').includes('左上'));
  return [first(/横:([0-9.]+)\(/u), first(/縦:([0-9.]+)\(/u), large.length === 1 ? Number(large[0]?.[1]) : NaN, first(/厚さ:([0-9.]+)\(/u)];
}

describe('1 つの角が大きな R のフレームに合う端のキャップの行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番を持たず、外形・左上の R・厚さ・頁・材質・質量が 2 本目の読みから決まる値と合う', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(ROUND_CORNER_CAP_RECORDS.map((record) => record.key));
    expect(ROUND_CORNER_CAP_RECORDS.length).toBeGreaterThan(0);
    for (const record of ROUND_CORNER_CAP_RECORDS) {
      const row = FIXTURE.find((item) => item.key === record.key);
      if (row === undefined) throw new Error(`fixture に ${record.key} が無い`);
      expect(JSON.stringify(row), record.key).not.toMatch(/[A-Z]{3}-[0-9]/u);
      expect([record.width, record.height, record.largeRadius, record.thickness], record.key).toEqual(outlineOf(row.outline));
      expect([record.shape, record.page, record.massG, record.material, record.fitsFrameKeys], record.key).toEqual(['r', Number(row.page),
        Number(row.mass.replace(/[^0-9.]/gu, '')), row.material === 'PA' ? 'nylon' : '', [row.frameKey]]);
    }
  });

  it('合うフレームの行と外形・左上の R・溝幅が同じで、族の行は形ができ、体積は面積 × 厚さ、質量は資料の値、合うフレームの鍵を持つ', () => {
    for (const record of ROUND_CORNER_CAP_RECORDS) {
      const frame = T_SLOT_OUTLINE_RECORDS.find((item) => item.key === record.fitsFrameKeys?.[0]);
      if (frame === undefined) throw new Error(`合うフレームの行が無い: ${record.key}`);
      expect([frame.width, frame.height, frame.outline?.radii[3], frame.slot], record.key)
        .toEqual([record.width, record.height, record.largeRadius, record.slot]);
      const row = FRAME_CAP_FAMILY.rows.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      const profile = frameCapProfile({ shape: 'r', width: record.width, height: record.height, thickness: record.thickness, armWidth: NaN,
        cornerRadius: 0, largeRadius: record.largeRadius ?? NaN });
      // キャップの円弧の角は、合うフレームの外周の 4 つ目の頂点(左上。R の大きな頂点)と同じ座標で、円弧の中心はその頂点から内へ R ずつ
      // (面積は円弧の向きが違っても同じなので座標で確かめる)。キャップは本体と同じ向き(回さない。付属の組の単体 accessorySets.test.ts)で
      // 端に付くので、キャップの R の角が本体の R の角に重なる。
      const vertex = frame.outline?.vertices[3];
      const arc = profile?.segments.find((segment) => segment.kind === 'arc');
      if (vertex === undefined || arc?.kind !== 'arc') throw new Error(`頂点か円弧が無い: ${record.key}`);
      const radius = record.largeRadius ?? NaN;
      expect([[arc.to[0], arc.from[1]], arc.center, arc.radius], record.key).toEqual([[vertex[0], vertex[1]],
        [vertex[0] - Math.sign(vertex[0]) * radius, vertex[1] - Math.sign(vertex[1]) * radius], radius]);
      expect(FRAME_CAP_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      expect(FRAME_CAP_FAMILY.nominalVolume(row, {}) ?? NaN, record.key).toBeCloseTo((profile?.areaMm2 ?? NaN) * record.thickness, 9);
      expect([FRAME_CAP_FAMILY.nominalMassG?.(row, {}), row.fitsFrameKeys, row.simplified], record.key)
        .toEqual([record.massG, record.fitsFrameKeys, ['取付けの脚と穴', '角の形']]);
    }
  });
});
