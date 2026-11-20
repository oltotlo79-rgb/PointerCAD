/**
 * 資料 1 の小さい部品の製品の行(smallPartBoxRows.ts。39 回目の読み 2 本で一致した値。外形を包む形)が、照らす側の読み
 * (smallPartBoxOracle.fixture.json。2 本目の文字。部品の種類だけは一般の呼び)と 1 行ずつ合う事の検査(統括の決定 2026-11-19 15:5x の 1)。
 * fixture の文字は、この検査が自分で読み解く: 全体の記入の 3 つの数(横の数に幅、縦の数に高さ、残りが奥行。寸法線の端の名前の無い
 * 数だけの記入も数として読む)・材質の語(JIS のアルミ合金の記号〔A6005C など〕はアルミ、JIS の SUS はステンレス、SPCC・SPHC・SS400・SECC は鋼、
 * POM・PA・PC などは樹脂、EPDM はゴム、黄銅・亜鉛ダイカスト〔ZDC〕は密度の無い材料)・1 個の質量(kg は g に直す。「記入なし」は質量なし)。
 * あわせて、族の行(形・体積・質量・出どころの資料)を製品の口(族の定数)を通して確かめる。行のある族だけを照らす。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CatalogFamily } from '../types.js';
import type { PanelPartRecord } from './panelPartCatalog.js';
import {
  CAP_ACCESSORY_BOX_FAMILY, DOOR_PART_BOX_FAMILY, DRAWER_PART_BOX_FAMILY, FOOT_PART_BOX_FAMILY, SLIDER_BOX_FAMILY,
} from './smallPartBoxCatalog.js';
import {
  CAP_ACCESSORY_BOX_RECORDS, DOOR_PART_BOX_RECORDS, DRAWER_PART_BOX_RECORDS, FOOT_PART_BOX_RECORDS, SLIDER_BOX_RECORDS,
} from './smallPartBoxRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./smallPartBoxOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
/** 行のある族と、その行の表(族の行の並びは行の表の並び)。 */
const FAMILIES: readonly (readonly [CatalogFamily, readonly PanelPartRecord[]])[] = [[SLIDER_BOX_FAMILY, SLIDER_BOX_RECORDS],
  [CAP_ACCESSORY_BOX_FAMILY, CAP_ACCESSORY_BOX_RECORDS], [FOOT_PART_BOX_FAMILY, FOOT_PART_BOX_RECORDS], [DOOR_PART_BOX_FAMILY, DOOR_PART_BOX_RECORDS],
  [DRAWER_PART_BOX_FAMILY, DRAWER_PART_BOX_RECORDS]];
const RECORDS: readonly PanelPartRecord[] = FAMILIES.flatMap(([, records]) => records);

/**
 * 「横:43.5(…)/縦:33/奥行:33(…)」→ 向きごとの数(括弧の参考寸法・φ・「なし」は外す。端の名前の無い数も読む)。
 * 決まった長さの品「断面の横:9.6/断面の縦:35.3/長さ:アウターL1=355.6、インナーL2=352.6」は、横は断面の横、縦は断面の縦、
 * 奥行は番号つきの長さ(L1= など)の長い方(縮めた時の長さ)として読む。
 */
function directions(text: string | undefined): ReadonlyMap<string, readonly number[]> {
  const found = new Map<string, readonly number[]>();
  for (const segment of (text ?? '').split('/')) {
    const [name, body] = segment.split(':');
    if (name === undefined || body === undefined) continue;
    found.set(name, body.split(';').flatMap((item) => {
      const match = /^([0-9]+(?:\.[0-9]+)?)(?:mm)?(?:\(|$)/u.exec(item.trim());
      return match?.[1] === undefined ? [] : [Number(match[1])];
    }));
  }
  const lengths = [...((text ?? '').split('/').find((segment) => segment.startsWith('長さ:')) ?? '').matchAll(/L[0-9]=([0-9]+(?:\.[0-9]+)?)/gu)]
    .map((match) => Number(match[1]));
  if (!found.has('断面の横') || lengths.length === 0) return found;
  return new Map([['横', found.get('断面の横') ?? []], ['縦', found.get('断面の縦') ?? []], ['奥行', [Math.max(...lengths)]]]);
}

const sorted = (values: readonly number[]): readonly number[] => [...values].sort((a, b) => a - b);
// 密度の表の金属の語に、密度の無い材料の語(樹脂・ゴム・エラストマー)を足す(この語を含む行は、部位ごとに材料の違う行と同じく密度を持たない)。
const MATERIAL_WORDS: readonly (readonly [string, string])[] = [['アルミ', 'aluminum'], ['ステンレス', 'stainless'], ['鉄', 'steel'], ['鋼', 'steel'],
  ['樹脂', 'resin'], ['PA', 'resin'], ['PP', 'resin'], ['ナイロン', 'resin'], ['ABS', 'resin'], ['ゴム', 'rubber']];
// 英字の前後が英字でない所の材料の記号(樹脂・ゴム・JIS の金属の記号。SPCC の中の PC などを拾わない)と、エラストマー・黄銅・「ステン」。
const SYMBOLS: readonly (readonly [RegExp, string])[] = [[/(?<![A-Z])POM(?![A-Z])/u, 'resin'], [/(?<![A-Z])(?:L|H)?D?PE(?![A-Z])/u, 'resin'],
  [/(?<![A-Z])PVC(?![A-Z])/u, 'resin'], [/(?<![A-Z])PBT(?![A-Z])/u, 'resin'], [/エラストマー/u, 'elastomer'], [/(?<![A-Z0-9])A[1-7][0-9]{3}/u, 'aluminum'],
  [/(?<![A-Z])PC(?![A-Z])/u, 'resin'], [/(?<![A-Z])EPDM(?![A-Z])/u, 'rubber'], [/黄銅/u, 'brass'], [/(?<![A-Z])ZDC(?![A-Z0-9])/u, 'zdc'],
  [/(?<![A-Z])SUS[0-9]{3}/u, 'stainless'], [/ステン/u, 'stainless'], [/(?<![A-Z])(?:SPCC|SPHC|SS400|SECC)(?![A-Z])/u, 'steel']];
const LABELS: Readonly<Record<string, string>> = { aluminum: 'アルミ', stainless: 'ステンレス', steel: '鉄', resin: '樹脂', rubber: 'ゴム',
  elastomer: 'エラストマー', brass: '黄銅', zdc: '亜鉛ダイカスト' };

function materialsOf(text: string | undefined): readonly string[] {
  const value = text ?? '';
  const first = new Map<string, number>();
  const note = (material: string, position: number): void => {
    first.set(material, Math.min(position, first.get(material) ?? position));
  };
  for (const [word, material] of MATERIAL_WORDS) {
    const position = value.indexOf(word);
    if (position >= 0) note(material, position);
  }
  for (const [pattern, material] of SYMBOLS) {
    const match = pattern.exec(value);
    if (match !== null) note(material, match.index);
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1]).map(([material]) => material);
}

function massOf(text: string | undefined): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)(k?)g$/u.exec(text ?? '');
  return match?.[1] === undefined ? null : Number(match[1]) * (match[2] === 'k' ? 1000 : 1);
}

describe('資料 1 の小さい部品の製品の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の集まりで、型番の形の文字を持たず、部品の種類は一般の呼び(製品の行の呼びの頭)', () => {
    expect([...FIXTURE.map((row) => row.key)].sort()).toEqual([...RECORDS.map((record) => record.key)].sort());
    // 型番の形(英字 2〜4 字・数 0〜3 字・「-」・英数 2 字以上)。材料の記号の途中(例 A6005CSS-T5 の CSS-T5)は型番と数えない。
    for (const row of FIXTURE) expect(JSON.stringify(row.cells), row.key).not.toMatch(/(?<![0-9A-Za-z])[A-Z]{2,4}[0-9]{0,3}-[0-9A-Z]{2,}/u);
    for (const record of RECORDS) {
      const kind = FIXTURE.find((row) => row.key === record.key)?.cells['部品の種類'];
      expect([kind, record.size.startsWith(`${kind ?? '?'} `)], record.key).toEqual([record.kind, true]);
    }
  });

  it('箱の 3 つの寸法・材質・質量・頁が照らす側の読みと合う(幅は横の数、高さは縦の数、奥行は残りの数)', () => {
    for (const record of RECORDS) {
      const cells = FIXTURE.find((row) => row.key === record.key)?.cells ?? {};
      const found = directions(cells['全体の記入']);
      expect(sorted([...found.values()].flat()), record.key).toEqual(sorted([record.width, record.depth, record.height]));
      expect(found.get('横') ?? [], record.key).toContain(record.width);
      expect(found.get('縦') ?? [], record.key).toContain(record.height);
      const materials = materialsOf(cells['材質']);
      expect(record.material === 'mixed' ? record.materialText : record.material, record.key)
        .toBe(record.material === 'mixed' ? materials.map((material) => LABELS[material]).join('・') : materials[0]);
      expect([record.massG, record.page], record.key).toEqual([massOf(cells['質量']), Number(cells['PDF頁'])]);
    }
  });

  it('族の行は行の表の並びで、形ができて名前は呼び、体積は箱、質量は資料の値で箱 × 密度より軽く、出どころは資料 1 の頁', () => {
    const density: Readonly<Record<string, number>> = { aluminum: 2.68, stainless: 7.93, steel: 7.85 };
    for (const [family, records] of FAMILIES) {
      expect(family.rows.map((row) => row.key), family.id).toEqual(records.map((record) => record.key));
      for (const record of records) {
        const row = family.rows.find((candidate) => candidate.key === record.key);
        if (row === undefined) throw new Error(`族に ${record.key} が無い`);
        expect(family.build(row, {})?.name, record.key).toBe(record.size);
        const box = record.width * record.depth * record.height;
        expect(family.nominalVolume(row, {}) ?? NaN, record.key).toBeCloseTo(box, 9);
        expect(family.nominalMassG?.(row, {}) ?? null, record.key).toBe(record.massG);
        // 外形を包む箱は中の抜けを持たないので、金属 1 つの行の資料の質量は、その密度の箱より軽い。資料に質量の無い行と、密度の無い材料の行は
        // 密度を持たず、部品表の材質は材質の文字(資料 2 の部品と同じ)。
        const metal = density[record.material];
        if (metal === undefined || record.massG === null) {
          expect([row.densityMaterialId, row.materialLabel], record.key).toEqual([undefined, record.materialText]);
        } else {
          expect([row.densityMaterialId, record.massG < box * metal / 1000], record.key).toEqual([record.material, true]);
        }
        expect([row.evidence.title, row.evidence.locator], record.key).toEqual(['資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)',
          `PDF ${record.page} 頁 部品の図(全体の寸法)と質量の記入`]);
      }
    }
  });
});
