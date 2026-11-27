/**
 * 資料 2 の足回りのロックの製品の行(capFootLockRows.ts。39h の読み 2 本で一致した値。外形を包む形)が、照らす側の読み
 * (capFootLockOracle.fixture.json。2 本目の文字。部品の種類だけは一般の呼び)と 1 行ずつ合う事の検査(統括 2026-11-19 19:3x)。
 * fixture の文字は、この検査が自分で読み解く: 横の数に幅、奥行の数に奥行、縦の「最大 a・最小 b」の a に高さ(b は最小高さと呼びに使う)、
 * 材質の語(SPHC は鋼)、1 個の質量(kg は g に直す)。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PRODUCT_CATALOG_REGISTRY } from '../registry.js';
import { buildCatalogItemPart, catalogItemNominalMass, catalogItemRejection, createCatalogItemSource } from '../source.js';

import { CAP_FOOT_LOCK_RECORDS } from './capFootLockRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./capFootLockOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();

/** 「横:105(…)/縦:最大97.5・最小82.5(…)/奥行:118(…)」→ 幅・奥行・高さ(縦の最大)・縦の最小。 */
function dimensionsOf(text: string | undefined): readonly number[] {
  const parts = new Map((text ?? '').split('/').map((segment) => {
    const at = segment.indexOf(':');
    return [segment.slice(0, at), segment.slice(at + 1)] as const;
  }));
  const lead = (name: string): number => Number(/^([0-9]+(?:\.[0-9]+)?)\(/u.exec(parts.get(name) ?? '')?.[1] ?? NaN);
  const up = parts.get('縦') ?? '';
  return [lead('横'), lead('奥行'), Number(/最大([0-9]+(?:\.[0-9]+)?)/u.exec(up)?.[1] ?? NaN), Number(/最小([0-9]+(?:\.[0-9]+)?)/u.exec(up)?.[1] ?? NaN)];
}

function materialAndMass(text: string | undefined): readonly (string | number)[] {
  const value = text ?? '';
  const at = value.lastIndexOf(';');
  const mass = /^([0-9]+(?:\.[0-9]+)?)(k?)g/u.exec(value.slice(at + 1));
  return [value.slice(0, at).includes('SPHC') ? 'steel' : '', mass?.[1] === undefined ? NaN : Number(mass[1]) * (mass[2] === 'k' ? 1000 : 1)];
}

describe('資料 2 の足回りのロックの製品の行と照らす側の読み', () => {
  it('キャスターの止めの最小高さを行へ渡し、既存の保存内容と包絡を保つ', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['cap-foot-box']);
    const family = PRODUCT_CATALOG_REGISTRY.loaded('cap-foot-box');
    const row = family?.rows.find((candidate) => candidate.key === 'caster-lock-105x118x97.5-fe');
    if (family === undefined || row === undefined) throw new Error('キャスターの止めがない');
    const saved = {
      kind: 'standardPart', catalog: 'catalogItem',
      size: 'キャスターの止め 105×118×97.5（外形を包む形・鉄・足を上げた時の高さ 82.5）',
      options: { family: 'cap-foot-box', item: 'caster-lock-105x118x97.5-fe' },
      catalogRevision: 'cap-foot-box-2026-11-r1', generatorRevision: 'panel-part-1',
    } as const;
    expect(createCatalogItemSource(family, row)).toEqual(saved);
    expect(catalogItemRejection(saved, PRODUCT_CATALOG_REGISTRY)).toBeNull();
    expect(catalogItemNominalMass(saved, PRODUCT_CATALOG_REGISTRY)).toBe(586);
    expect(row.densityMaterialId).toBe('steel');
    expect(row.dims).toEqual({ width: 105, depth: 118, height: 97.5, heightMin: 82.5, massG: 586 });
    expect(family.nominalVolume(row, {})).toBe(105 * 118 * 97.5);
    const restored = buildCatalogItemPart(saved, PRODUCT_CATALOG_REGISTRY);
    expect(restored).not.toBeNull();
    expect(restored).toEqual(family.build({ ...row, dims: { width: 105, depth: 118, height: 97.5 } }, {}));
  });

  it('製品の行と fixture は同じ鍵の並びで、型番の形の文字を持たず、部品の種類は一般の呼び(製品の行の呼びの頭)', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(CAP_FOOT_LOCK_RECORDS.map((record) => record.key));
    expect(CAP_FOOT_LOCK_RECORDS.length).toBeGreaterThan(0);
    for (const row of FIXTURE) expect(JSON.stringify(row.cells), row.key).not.toMatch(/[A-Z]{2,4}[0-9]{0,3}-[0-9A-Z]{2,}/u);
    for (const record of CAP_FOOT_LOCK_RECORDS) {
      const kind = FIXTURE.find((row) => row.key === record.key)?.cells['部品の種類'];
      expect([kind, record.size.startsWith(`${kind ?? '?'} `)], record.key).toEqual([record.kind, true]);
    }
  });

  it('箱の幅・奥行・高さ(足を下げた時の高さ)・材質・質量・頁が照らす側の読みと合い、足を上げた時の高さを呼びに書く', () => {
    for (const record of CAP_FOOT_LOCK_RECORDS) {
      const cells = FIXTURE.find((row) => row.key === record.key)?.cells ?? {};
      const [width, depth, high, low] = dimensionsOf(cells['全体の記入']);
      expect([record.width, record.depth, record.height], record.key).toEqual([width, depth, high]);
      expect(record.heightMin, record.key).toBe(low);
      expect(record.size, record.key).toContain(`足を上げた時の高さ ${String(low)}`);
      expect([record.material, record.massG, record.page], record.key).toEqual([...materialAndMass(cells['材質と質量']), Number(cells['PDF頁'])]);
      expect(record.simplified, record.key).toEqual(['外形を包む形で、細部は作っていない']);
    }
  });
});
