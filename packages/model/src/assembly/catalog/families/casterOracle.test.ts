/**
 * キャスターの製品の行(casterRows.ts。24 回目の読み 2 本で一致した値)が、照らす側の読み(casterOracle.fixture.json。24 回目の 2 本目の文字)と
 * 1 行ずつ合う事の検査。fixture の文字は、この検査が自分で読み解く: 頁の記号の意味(起点〜終点の語)から寸法の種類を決め、型番ごとの値を
 * 記号か語のまま種類に当てる(φ を外す。括弧の参考寸法・範囲・「−」は数にしない)。固定のキャスターの偏りは 0。
 * カタログに車輪の幅の記入が無い行は、fixture の「1 つの資料の車輪の幅」(製造元が公開している一覧の数)を使い、その一覧の車輪の径が
 * カタログの径と同じ事も確かめる。双輪は一覧の全体の幅と両輪の内側の間から 1 輪の幅とすき間を戻す。同じ寸法で材質の違う行は
 * 鍵の後ろに材質の語が付く(中身の照らしは同じ)。差込みの行は、取付けの文と、全体の高さの基準が座の上の面である事を確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CASTER_RECORDS } from './casterRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./casterOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();

/** 記号の意味の文から寸法の種類(担当の道具と同じ決まりを、この検査が自分で持つ)。 */
function symbolKind(text: string): string | null {
  const rules: readonly (readonly [string, (value: string) => boolean])[] = [
    ['plateThickness', (value) => /板上面〜板下面|板上面〜下面|取付け板上面〜下面/u.test(value)],
    ['threadDiameter', (value) => value.includes('おねじ')],
    ['offset', (value) => /旋回|差込み軸中心/u.test(value) && /車輪軸心|車軸/u.test(value)],
    ['wheelWidth', (value) => value.includes('車輪') && /左側面|右側面/u.test(value)],
    ['wheelDiameter', (value) => /車輪外周|車輪の?上端/u.test(value) && !/接地|座|板/u.test(value)],
    ['height', (value) => /接地面|車輪下端/u.test(value) && /板上面|座|取付け面|根元/u.test(value)],
    ['pinLength', (value) => value.includes('差込み軸') && value.includes('先端')],
    ['stemLength', (value) => value.includes('ねじ') && value.includes('先端') && !value.includes('差込み軸')],
    ['pitchX', (value) => /左穴中心|左右の取付け穴中心|左右の穴中心/u.test(value)],
    ['pitchY', (value) => /上穴中心|上下の取付け穴中心|上下の穴中心/u.test(value)],
    ['holeDiameter', (value) => /穴径|穴の径/u.test(value)],
    ['plateWidth', (value) => value.includes('板左')],
    ['plateDepth', (value) => /板上(外)?端/u.test(value) && !value.includes('穴')],
  ];
  if (/変位|破線/u.test(text)) return null;
  return rules.find(([, test]) => test(text))?.[0] ?? null;
}

const WORDS: readonly (readonly [string, string])[] = [['車輪幅', 'wheelWidth'], ['車輪径', 'wheelDiameter'], ['ねじ長', 'stemLength'],
  ['板厚', 'plateThickness'], ['穴径', 'holeDiameter'], ['偏', 'offset']];
/** 全体の高さに当てる語(「突起高さ」など、ほかの高さを全体の高さにしない)。 */
const HEIGHT_WORDS: ReadonlySet<string> = new Set(['高さ', '取付け高さ', '取付高さ', '全体の高さ', '全高']);

function wordKind(key: string): string | null {
  if (key === '幅') return 'wheelWidth';
  if (key === '径') return 'wheelDiameter';
  if (key === 'ねじ') return 'thread';
  if (HEIGHT_WORDS.has(key)) return 'height';
  return WORDS.find(([word]) => key.includes(word))?.[1] ?? null;
}

/** 記号の意味の文を「記号 = 定義の文」の組に分ける(頁に表が 2 つ以上ある時の区切りの語〔上段・ねじ軸・板・差込み・丸数字〕は記号の前から外す)。 */
function definitions(cells: Cells): readonly (readonly [string, string])[] {
  return (cells['記号の意味'] ?? '').split(';').flatMap((item): (readonly [string, string])[] => {
    const match = /^([^=]+)=(.*)$/u.exec(item.replace(/^(?:上段|中段|下段|ねじ軸|板|差込み|[①-⑳])\s*/u, ''));
    return match?.[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]]];
  });
}

/** fixture の 1 行から、寸法の種類 → 値(数か、ねじの呼び)。 */
function readValues(cells: Cells): ReadonlyMap<string, number | string> {
  const symbols = new Map<string, string | null>();
  for (const [symbol, text] of definitions(cells)) {
    const kind = symbolKind(text);
    symbols.set(symbol, symbols.has(symbol) && symbols.get(symbol) !== kind ? null : kind);
  }
  const values = new Map<string, number | string>();
  const bySymbol = new Set<string>();
  for (const item of (cells['型番ごとの寸法'] ?? '').split(';')) {
    const [key, raw] = item.split(':');
    if (key === undefined || raw === undefined) continue;
    const kind = symbols.has(key) ? symbols.get(key) ?? null : wordKind(key);
    // 記号で決まった種類は、語の値で上書きしない。
    if (kind !== null && !symbols.has(key) && bySymbol.has(kind)) continue;
    if (kind !== null && symbols.has(key)) bySymbol.add(kind);
    if (kind === 'thread' || kind === 'threadDiameter') {
      const thread = /^\(?M([0-9.]+)/u.exec(raw);
      if (thread?.[1] !== undefined) values.set('thread', `M${thread[1]}`);
      continue;
    }
    // 「4-8.8」の数の前置き(穴の数)は穴の径の時だけ外す。ほかの「a-b」は範囲なので数にしない。
    const pattern = kind === 'holeDiameter' ? /^(?:[0-9]+-)?([0-9]+(?:\.[0-9]+)?)$/u : /^([0-9]+(?:\.[0-9]+)?)$/u;
    const number = pattern.exec(raw.replace('φ', '').replace('mm', ''));
    if (kind !== null && number?.[1] !== undefined) values.set(kind, Number(number[1]));
  }
  return values;
}

describe('キャスターの製品の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番の形の文字を持たない', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(CASTER_RECORDS.map((record) => record.key));
    // 型番の形(英字 2〜4 の後に数字が続く型番も含む)を持たない。
    for (const row of FIXTURE) expect(JSON.stringify(row.cells), row.key).not.toMatch(/[A-Z]{2,4}[0-9]{0,3}-[0-9A-Z]{2,}/u);
  });

  it('車輪の径・幅・偏り・全体の高さ・取付けの形・自在と止め・材質と質量・頁が照らす側の読みと合う', () => {
    for (const record of CASTER_RECORDS) {
      const cells = FIXTURE.find((row) => row.key === record.key)?.cells ?? {};
      const values = readValues(cells);
      const kind = cells['型番ごとの種類'] ?? '';
      expect([record.swivel, record.brake], record.key).toEqual([kind.includes('自在'), /止め付き|ブレーキ付/u.test(kind)]);
      // カタログに幅の記入が無い行だけ、1 つの資料の幅(その資料の車輪の径がカタログの径と同じ時だけ)。印 singleSource と揃う。
      // 双輪は、一覧の全体の幅と両輪の内側の間から、1 輪の幅 =(全体 − 内側の間)/ 2・すき間 = 内側の間(26 回目の読みで W1・W2 の意味を確かめた)。
      const singleWidth = cells['1 つの資料の車輪の幅'];
      const innerGap = cells['1 つの資料の両輪の内側の間'];
      const single = singleWidth !== undefined && !values.has('wheelWidth');
      const gap = single && innerGap !== undefined ? Number(innerGap) : undefined;
      const sources = gap === undefined ? ['wheelWidth'] : ['wheelWidth', 'twinGap'];
      expect([record.singleSource ?? [], single, record.twinGap], record.key).toEqual([single ? sources : [], singleWidth !== undefined, gap]);
      if (single) expect(Number(cells['1 つの資料の車輪の径']), record.key).toBe(values.get('wheelDiameter'));
      const width = single ? (Number(singleWidth) - (gap ?? 0)) / (gap === undefined ? 1 : 2) : values.get('wheelWidth');
      expect([record.wheelDiameter, record.wheelWidth, record.height], record.key)
        .toEqual([values.get('wheelDiameter'), width, values.get('height')]);
      expect(record.offset, record.key).toBe(record.swivel ? values.get('offset') : values.get('offset') ?? 0);
      if (record.mount.kind === 'none') {
        // 差込み: 取付けの文に「差込み」、全体の高さの記号の定義は座の上の面まで(どれにも軸の先端が無く、どれかに座がある)。軸の長さは読めた時だけ。
        const heights = definitions(cells).filter(([, text]) => symbolKind(text) === 'height').map(([, text]) => text);
        expect([cells['型番ごとの取付け']?.includes('差込み'), heights.length > 0, heights.every((text) => !text.includes('先端')),
          heights.some((text) => text.includes('座'))], record.key).toEqual([true, true, true, true]);
        expect(record.pinLength, record.key).toBe(values.get('pinLength'));
      } else if (record.mount.kind === 'stem') {
        expect([record.mount.thread, record.mount.length], record.key).toEqual([values.get('thread'), values.get('stemLength')]);
      } else {
        expect([record.mount.width, record.mount.depth, record.mount.thickness], record.key)
          .toEqual([values.get('plateWidth'), values.get('plateDepth'), values.get('plateThickness')]);
        const [x, y, size] = [values.get('pitchX'), values.get('pitchY'), values.get('holeDiameter')];
        const holes = typeof x === 'number' && typeof y === 'number' && typeof size === 'number'
          ? [-1, 1].flatMap((sx) => [-1, 1].map((sy) => [sx * x / 2, sy * y / 2, size])) : [];
        expect(record.mount.holes, record.key).toEqual(holes);
      }
      const [body = '', wheel = '', mass = ''] = (cells['型番ごとの材質と質量'] ?? '').split(';');
      const label = [[body, '本体'], [wheel, '車輪']].filter(([text]) => text !== '' && text !== '記入なし')
        .map(([text, name]) => `${text ?? ''}(${name ?? ''})`).join('・');
      expect([record.materialText, record.massG, record.page], record.key).toEqual([label,
        Number(/^([0-9.]+)g$/u.exec(mass)?.[1]), Number(cells['PDF頁'])]);
    }
  });
});
