/**
 * 資料 1 の長物の製品の行(slotLongPartRows.ts。39 回目の読み 2 本で一致した値。断面の外形を包む長方形 × 長さ)が、照らす側の読み
 * (slotLongPartOracle.fixture.json。2 本目の文字。部品の種類だけは一般の呼び)と 1 行ずつ合う事の検査(統括の決定 2026-11-19 15:5x の 1・3)。
 * fixture の文字は、この検査が自分で読み解く: 断面の横と縦の数(寸法線の端の名前の無い数だけの記入も数として読む)・長さの上限
 * (定尺の L=・ℓ= の数か切り売りの範囲の大きい方)・材質の語(JIS のアルミ合金の記号はアルミ、エラストマー・樹脂・ゴムは密度を持たない材料)・
 * 単位質量(g/m・kg/m は kg/m に、定尺 1 本の g〔「g/本」を含む〕は ÷ 定尺)。あわせて、族の行(形・体積・質量・長さの上限)を確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SLOT_LONG_PART_FAMILY } from './smallPartBoxCatalog.js';
import { SLOT_LONG_PART_RECORDS } from './slotLongPartRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./slotLongPartOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const NUMBER = '[0-9]+(?:\\.[0-9]+)?';

/** 「断面の横:12(…)/断面の縦:6/長さ:定尺L=2000(…)」→ 横・縦・長さの上限(無ければ null)。 */
function sectionOf(text: string | undefined): { readonly width: number | null; readonly height: number | null; readonly max: number | null } {
  const parts = new Map((text ?? '').split('/').map((segment) => {
    const at = segment.indexOf(':');
    return [segment.slice(0, at), segment.slice(at + 1)] as const;
  }));
  const first = (name: string): number | null => {
    const match = new RegExp(`^(${NUMBER})(?:mm)?(?:\\(|$)`, 'u').exec((parts.get(name) ?? '').trim());
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  const lengthText = parts.get('長さ') ?? '';
  const lengths = [...lengthText.matchAll(new RegExp(`[Llℓ]=(${NUMBER})`, 'gu'))].map((match) => Number(match[1]))
    .concat([...lengthText.matchAll(new RegExp(`(${NUMBER})[~〜～](${NUMBER})`, 'gu'))].flatMap((match) => [Number(match[1]), Number(match[2])]));
  return { width: first('断面の横'), height: first('断面の縦'), max: lengths.length === 0 ? null : Math.max(...lengths) };
}

function unitMassOf(text: string | undefined, stock: number | null): number | null {
  const perLength = new RegExp(`^(${NUMBER})(k?)g/m$`, 'u').exec(text ?? '');
  if (perLength?.[1] !== undefined) return Number(perLength[1]) * (perLength[2] === 'k' ? 1 : 0.001);
  const piece = new RegExp(`^(${NUMBER})(k?)g(?:/本)?$`, 'u').exec(text ?? '');
  return piece?.[1] === undefined || stock === null ? null : Number(piece[1]) * (piece[2] === 'k' ? 1000 : 1) / stock;
}

/**
 * 材質の記入 → 製品の行の材料(金属 1 つは密度の材料、エラストマー・樹脂・ゴム・密度の無い材料を含む時は 'mixed' と材質の文字)。
 * 樹脂とゴムの記号は行の表を作る道具と同じ(英字の前後が英字でない所の POM・PA・PP・PVC・PBT・ABS・PC・EPDM と LDPE などの PE)。
 * JIS の SUS はステンレス、SPCC・SPHC・SS400・SECC は鋼。
 */
function materialOf(text: string | undefined): readonly [string, string | undefined] {
  const value = text ?? '';
  if (value.includes('エラストマー')) return ['mixed', 'エラストマー'];
  if (/樹脂|ゴム|ナイロン|黄銅|(?<![A-Z])(?:POM|PA|PP|PVC|PBT|ABS|PC|EPDM|(?:L|H)?D?PE)(?![A-Z])|(?<![A-Z])ZDC(?![A-Z0-9])/u.test(value)) {
    return ['mixed', undefined];
  }
  if (value.includes('アルミ') || /(?<![A-Z0-9])A[1-7][0-9]{3}/u.test(value)) return ['aluminum', undefined];
  if (value.includes('ステン') || /(?<![A-Z])SUS[0-9]{3}/u.test(value)) return ['stainless', undefined];
  return [/鉄|鋼|(?<![A-Z])(?:SPCC|SPHC|SS400|SECC)(?![A-Z])/u.test(value) ? 'steel' : '', undefined];
}

describe('資料 1 の長物の製品の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番の形の文字を持たず、部品の種類は一般の呼び(製品の行の呼びの頭)', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(SLOT_LONG_PART_RECORDS.map((record) => record.key));
    expect(SLOT_LONG_PART_RECORDS.length).toBeGreaterThan(0);
    for (const row of FIXTURE) expect(JSON.stringify(row.cells), row.key).not.toMatch(/(?<![0-9A-Za-z])[A-Z]{2,4}[0-9]{0,3}-[0-9A-Z]{2,}/u);
    for (const record of SLOT_LONG_PART_RECORDS) {
      const kind = FIXTURE.find((row) => row.key === record.key)?.cells['部品の種類'];
      expect([kind, record.size.startsWith(`${kind ?? '?'} `)], record.key).toEqual([record.kind, true]);
    }
  });

  it('断面の 2 つの数・長さの上限・材質・単位質量・頁が照らす側の読みと合い、定尺 1 本の質量から直した行だけが注を持つ', () => {
    for (const record of SLOT_LONG_PART_RECORDS) {
      const cells = FIXTURE.find((row) => row.key === record.key)?.cells ?? {};
      const section = sectionOf(cells['全体の記入']);
      expect([section.width, section.height, section.max], record.key).toEqual([record.width, record.height, record.maxLength]);
      const unit = unitMassOf(cells['質量'], section.max);
      expect(unit === null ? null : Number(unit.toPrecision(12)), record.key)
        .toBe(record.unitMassKgPerM === null ? null : Number(record.unitMassKgPerM.toPrecision(12)));
      expect(record.massNote !== undefined, record.key).toBe(/g(?:\/本)?$/u.test(cells['質量'] ?? '') && !/g\/m$/u.test(cells['質量'] ?? ''));
      const [material, text] = materialOf(cells['材質']);
      expect(record.material, record.key).toBe(material);
      if (text !== undefined) expect(record.materialText, record.key).toBe(text);
      expect(record.page, record.key).toBe(Number(cells['PDF頁']));
    }
  });

  it('族の行は行の表の並びで、形は断面の長方形 × 長さ、体積は断面 × 長さ、質量は単位質量 × 長さ、長さの上限を超える長さは形を作らない', () => {
    expect(SLOT_LONG_PART_FAMILY.rows.map((row) => row.key)).toEqual(SLOT_LONG_PART_RECORDS.map((record) => record.key));
    const values = { length: '300' };
    for (const record of SLOT_LONG_PART_RECORDS) {
      const row = SLOT_LONG_PART_FAMILY.rows.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(SLOT_LONG_PART_FAMILY.build(row, values)?.name, record.key).toBe(`${record.size}×300`);
      expect(SLOT_LONG_PART_FAMILY.nominalVolume(row, values) ?? NaN, record.key).toBeCloseTo(record.width * record.height * 300, 9);
      expect(SLOT_LONG_PART_FAMILY.nominalMassG?.(row, values) ?? null, record.key)
        .toBe(record.unitMassKgPerM === null ? null : record.unitMassKgPerM * 300);
      if (record.maxLength !== null) {
        const over = { length: String(record.maxLength + 1) };
        expect([SLOT_LONG_PART_FAMILY.build(row, over), SLOT_LONG_PART_FAMILY.nominalVolume(row, over)], record.key).toEqual([null, null]);
      }
    }
  });
});
