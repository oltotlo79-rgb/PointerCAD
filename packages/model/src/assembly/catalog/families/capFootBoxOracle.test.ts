/**
 * キャップと足の部品の製品の行(capFootBoxRows.ts。21 回目の読み 2 本で一致した値)が、照らす側の読み(capFootBoxOracle.fixture.json。20 回目の 2 本目の
 * 文字。部品の種類だけは一般の呼び)と 1 行ずつ合う事の検査(統括の決定 2026-11-18 14:4x の (3)・16:2x)。fixture の文字は、この検査が自分で読み解く:
 * 全体の記入の 3 つの数(横の数に幅、縦の数に高さ、残りが奥行)・材質の語・1 個の質量(kg は g に直す)。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CAP_FOOT_BOX_RECORDS } from './capFootBoxRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./capFootBoxOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();

/** 「横:43.5(…)(上図)/縦:33(…)/奥行:33(…)」→ 向きごとの数(括弧の参考寸法・φ・「なし」は外す)。 */
function directions(text: string | undefined): ReadonlyMap<string, readonly number[]> {
  const found = new Map<string, readonly number[]>();
  for (const segment of (text ?? '').split('/')) {
    const [name, body] = segment.split(':');
    if (name === undefined || body === undefined) continue;
    found.set(name, body.split(';').flatMap((item) => {
      const match = /^([0-9]+(?:\.[0-9]+)?)\(/u.exec(item);
      return match?.[1] === undefined ? [] : [Number(match[1])];
    }));
  }
  return found;
}

const sorted = (values: readonly number[]): readonly number[] => [...values].sort((a, b) => a - b);
// 密度の表の金属の語に、密度の無い材料の語(樹脂・ゴム)を足す(この語を含む行は、部位ごとに材料の違う行と同じく密度を持たない)。
// 「スチール」は鋼として読む(46c 回目の床の止め具の記入。行の表の道具と同じ。統括 2026-11-22 07:05)。
const MATERIAL_WORDS: readonly (readonly [string, string])[] = [['アルミ', 'aluminum'], ['ステンレス', 'stainless'], ['鉄', 'steel'], ['鋼', 'steel'],
  ['スチール', 'steel'], ['樹脂', 'resin'], ['PA', 'resin'], ['PP', 'resin'], ['ナイロン', 'resin'], ['ABS', 'resin'], ['ゴム', 'rubber']];
const LABELS: Readonly<Record<string, string>> = { aluminum: 'アルミ', stainless: 'ステンレス', steel: '鉄', resin: '樹脂', rubber: 'ゴム' };

function materialsOf(text: string | undefined): readonly string[] {
  const value = text ?? '';
  const first = new Map<string, number>();
  for (const [word, material] of MATERIAL_WORDS) {
    const position = value.indexOf(word);
    if (position >= 0) first.set(material, Math.min(position, first.get(material) ?? position));
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1]).map(([material]) => material);
}

function massOf(text: string | undefined): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)(k?)g$/u.exec(text ?? '');
  return match?.[1] === undefined ? null : Number(match[1]) * (match[2] === 'k' ? 1000 : 1);
}

describe('キャップと足の部品の製品の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番の形の文字を持たず、部品の種類は一般の呼び(製品の行の呼びの頭)', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(CAP_FOOT_BOX_RECORDS.map((record) => record.key));
    for (const row of FIXTURE) expect(JSON.stringify(row.cells), row.key).not.toMatch(/[A-Z]{2,4}-[0-9A-Z]{2,}/u);
    for (const record of CAP_FOOT_BOX_RECORDS) {
      const kind = FIXTURE.find((row) => row.key === record.key)?.cells['部品の種類'];
      expect([kind, record.size.startsWith(`${kind ?? '?'} `)], record.key).toEqual([record.kind, true]);
    }
  });

  it('箱の 3 つの寸法・材質・質量・頁が照らす側の読みと合う(幅は横の数、高さは縦の数、奥行は残りの数)', () => {
    for (const record of CAP_FOOT_BOX_RECORDS) {
      const cells = FIXTURE.find((row) => row.key === record.key)?.cells ?? {};
      const found = directions(cells['全体の記入']);
      expect(sorted([...found.values()].flat()), record.key).toEqual(sorted([record.width, record.depth, record.height]));
      expect(found.get('横') ?? [], record.key).toContain(record.width);
      expect(found.get('縦') ?? [], record.key).toContain(record.height);
      const materials = materialsOf(cells['材質']);
      expect(record.material === 'mixed' ? record.materialText : record.material, record.key)
        .toBe(record.material === 'mixed' ? materials.map((material) => LABELS[material]).join('・') : materials[0]);
      expect([record.massG, record.page], record.key).toEqual([massOf(cells['質量_g']), Number(cells['PDF頁'])]);
    }
  });
});
