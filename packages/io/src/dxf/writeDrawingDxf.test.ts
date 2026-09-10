import { describe, expect, it } from 'vitest';
import type { DrawingLayer } from '@pointercad/model';
import { parseDxfTags, type DxfTag } from './dxfTags.js';
import { writeDrawingDxf } from './writeDrawingDxf.js';
import { readDxf } from './readDxf.js';

type RenderPrimitive = Parameters<typeof writeDrawingDxf>[0]['primitives'][number];
type RenderPath = Extract<RenderPrimitive, { kind: 'path' }>;
type RenderText = Extract<RenderPrimitive, { kind: 'text' }>;
const LINE_DASH_PATTERNS = { solid: [], dashed: [3, 1], chain: [10, 1, 1, 1], chain2: [10, 1, 1, 1, 1, 1] } as const;

const layers: readonly DrawingLayer[] = Array.from({ length: 7 }, (_, index) => ({ id: `layer-${index}`, name: `Layer${index}`,
  visible: true, printable: true, color: '#000000', lineType: 'solid', lineWidth: 0.25 }));
const line: RenderPath = { kind: 'path', ownerId: 'dimension', layerId: 'layer-0', transform: [1, 0, 0, 1, 0, 0],
  clip: null, fill: null, fillRule: 'nonzero', stroke: { color: '#000000', widthMm: 0.5, dashMm: [] },
  subpaths: [{ commands: [{ kind: 'M', to: [10, 20] }, { kind: 'L', to: [110, 20] }] }] };
const text: RenderText = { kind: 'text', ownerId: 'dimension', layerId: 'layer-0', transform: [1, 0, 0, 1, 0, 0], clip: null,
  fill: '#000000', text: '100±0.1', position: [60, 25], angle: 0, anchor: 'middle', baseline: 'bottom', outline: null,
  metrics: { fontId: 'Noto', sizeMm: 3.5, advanceMm: 10, inkBounds: { left: 0, right: 10, bottom: -1, top: 3 } } };
const arrow: RenderPath = { ...line, stroke: null, fill: '#000000', subpaths: [{ commands: [
  { kind: 'M', to: [10, 20] }, { kind: 'L', to: [13, 19] }, { kind: 'L', to: [13, 21] }, { kind: 'Z' },
] }] };
function output(primitives: readonly RenderPrimitive[] = [line], tableLayers = layers) {
  return writeDrawingDxf({ widthMm: 420, heightMm: 297, primitives }, tableLayers);
}
function records(value: string, kind: string): readonly (readonly DxfTag[])[] {
  const result: DxfTag[][] = []; let current: DxfTag[] | null = null;
  for (const tag of parseDxfTags(value)) {
    if (tag.code === 0) { if (current !== null) result.push(current); current = tag.value === kind ? [tag] : null; }
    else current?.push(tag);
  }
  if (current !== null) result.push(current);
  return result;
}
const field = (record: readonly DxfTag[], code: number): string | undefined => record.find((tag) => tag.code === code)?.value;

describe('図面の共通描画からR12 DXFを書き出す(P8-48)', () => {
  it('AC1009で終端EOFまで書く', () => {
    const value = output().text; expect(value).toContain('AC1009'); expect(parseDxfTags(value).at(-1)).toEqual({ code: 0, value: 'EOF' });
  });
  it('LTYPEは4種類を既存のmmパターンから書く', () => {
    const types = records(output().text, 'LTYPE'); expect(types.map((record) => field(record, 2))).toEqual(['CONTINUOUS', 'DASHED', 'CENTER', 'PHANTOM']);
    expect(types[1].filter((tag) => tag.code === 49).map((tag) => Number(tag.value))).toEqual([3, -1]);
  });
  it('図面7層とR12に必要な0層を保存する', () => {
    const names = records(output().text, 'LAYER').map((record) => field(record, 2));
    expect(names).toEqual(['0', ...layers.map((layer) => layer.name)]);
  });
  it('非表示層はLAYERの色番号を負にする', () => {
    const recordsByLayer = records(output([], layers.map((layer) => ({ ...layer, visible: false }))).text, 'LAYER');
    expect(Number(field(recordsByLayer[1], 62))).toBe(-7);
  });
  it('日本語のレイヤーをCIFへ符号化しUTF-8を混ぜない', () => {
    const value = output([line], [{ ...layers[0], name: '外形' }]).text;
    expect(value).toContain('\\U+5916\\U+5F62'); expect(value).not.toContain('外形');
  });
  it.each(['外形', '\\U+5916', '寸法%%d'])('レイヤー%sを再読込しても文字が変わらない', (name) => {
    const value = output([line], [{ ...layers[0], name }]).text;
    const restored = readDxf(parseDxfTags(value));
    expect(restored.entities).toHaveLength(1); expect(restored.entities[0].layer).toBe(name);
    expect(restored.entities[0]).toMatchObject({ kind: 'line', start: { x: 10, y: 20 }, end: { x: 110, y: 20 } });
  });
  it('寸法をLINEと黒三角のSOLIDとTEXTに分ける', () => {
    const value = output([line, arrow, text]).text;
    expect(records(value, 'LINE')).toHaveLength(1); expect(records(value, 'SOLID')).toHaveLength(1);
    expect(records(value, 'TEXT')).toHaveLength(1); expect(records(value, 'DIMENSION')).toHaveLength(0);
  });
  it('TEXTは輪郭がなくても文字列・高さ・中央下揃えを保つ', () => {
    const record = records(output([text]).text, 'TEXT')[0];
    expect(field(record, 1)).toBe('100\\U+00B10.1'); expect(field(record, 40)).toBe('3.5');
    expect(field(record, 72)).toBe('1'); expect(field(record, 73)).toBe('1');
  });
  it('製作指示の外周と穴を閉じた輪郭線で保存し、回転・文字揃え・変換後の紙面位置を保つ', () => {
    const glyph: RenderText = { ...text, ownerId: 'gdt', angle: Math.PI / 2, transform: [2, 0, 0, 2, 5, 7], outline: [
      { commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [10, 0] }, { kind: 'L', to: [10, 4] }, { kind: 'L', to: [0, 4] }, { kind: 'Z' }] },
      { commands: [{ kind: 'M', to: [2, 1] }, { kind: 'L', to: [2, 3] }, { kind: 'L', to: [8, 3] }, { kind: 'L', to: [8, 1] }, { kind: 'Z' }] },
    ] };
    const result = writeDrawingDxf({ widthMm: 420, heightMm: 297, primitives: [glyph, text] }, layers, 0.001, { outlineTextOwnerIds: new Set(['gdt']) });
    expect(result.outlinedTextCount).toBe(1); expect(result.skippedPrimitiveCount).toBe(0);
    expect(records(result.text, 'TEXT')).toHaveLength(1);
    expect(records(result.text, 'POLYLINE').map((record) => field(record, 70))).toEqual(['1', '1']);
    const vertices = records(result.text, 'VERTEX').map((record) => [Number(field(record, 10)), Number(field(record, 20))]);
    expect(vertices).toHaveLength(8);
    const expected = [[123, 47], [123, 67], [115, 67], [115, 47], [121, 51], [117, 51], [117, 63], [121, 63]];
    for (const [index, vertex] of vertices.entries()) for (const axis of [0, 1]) expect(vertex[axis]).toBeCloseTo(expected[index][axis], 8);
  });
  it('製作指示の曲線字形を0.001mm以内の輪郭にし、TEXTへ戻さない', () => {
    const glyph: RenderText = { ...text, outline: [{ commands: [
      { kind: 'M', to: [0, 0] }, { kind: 'C', control1: [0, 10], control2: [10, 10], to: [10, 0] }, { kind: 'Z' },
    ] }] };
    const result = writeDrawingDxf({ widthMm: 420, heightMm: 297, primitives: [glyph] }, layers, 0.001, { outlineTextOwnerIds: new Set(['dimension']) });
    expect(result.outlinedTextCount).toBe(1); expect(result.flattenedCurveCount).toBe(1);
    expect(records(result.text, 'TEXT')).toHaveLength(0); expect(records(result.text, 'VERTEX').length).toBeGreaterThan(10);
    const vertices = records(result.text, 'VERTEX').map((record) => [Number(field(record, 10)), Number(field(record, 20))]);
    for (let sample = 0; sample <= 100; sample++) {
      const t = sample / 100, x = 55 + 30 * (1 - t) * t * t + 10 * t ** 3, y = 26 + 30 * (1 - t) * t;
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 1; index < vertices.length; index++) {
        const [a, b] = [vertices[index - 1], vertices[index]], dx = b[0] - a[0], dy = b[1] - a[1];
        const along = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
        distance = Math.min(distance, Math.hypot(x - a[0] - along * dx, y - a[1] - along * dy));
      }
      expect(distance).toBeLessThanOrEqual(0.001);
    }
  });
  it.each(['missing', 'open', 'nonfinite', 'empty'] as const)('製作指示の%s輪郭をフォント依存の文字へ置換せず、全体を省略として報告する', (kind) => {
    const closed = { commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [3, 0] }, { kind: 'L', to: [0, 3] }, { kind: 'Z' }] } as const;
    const glyph: RenderText = { ...text, outline: kind === 'missing' ? null : kind === 'empty' ? [] : [closed,
      { commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [3, kind === 'nonfinite' ? Number.NaN : 0] }] }] };
    const result = writeDrawingDxf({ widthMm: 420, heightMm: 297, primitives: [line, glyph] }, layers, 0.001, { outlineTextOwnerIds: new Set(['dimension']) });
    expect(result.skippedPrimitiveCount).toBe(1); expect(result.outlinedTextCount).toBe(0);
    expect(records(result.text, 'TEXT')).toHaveLength(0); expect(records(result.text, 'POLYLINE')).toHaveLength(0);
    expect(records(result.text, 'LINE')).toHaveLength(1);
  });
  it('原点は左下でy=20を反転しない', () => {
    const record = records(output().text, 'LINE')[0]; expect(field(record, 10)).toBe('10'); expect(field(record, 20)).toBe('20');
    expect(field(record, 11)).toBe('110'); expect(field(record, 21)).toBe('20');
  });
  it('拡大と平行移動を紙面座標へ適用する', () => {
    const record = records(output([{ ...line, transform: [2, 0, 0, 2, 5, 7] }]).text, 'LINE')[0];
    expect(field(record, 10)).toBe('25'); expect(field(record, 20)).toBe('47'); expect(field(record, 11)).toBe('225');
  });
  it.each([
    ['solid', 'CONTINUOUS'], ['dashed', 'DASHED'], ['chain', 'CENTER'], ['chain2', 'PHANTOM'],
  ] as const)('%sは実体の線種%sへ渡す', (id, name) => {
    const record = records(output([{ ...line, stroke: { color: '#000000', widthMm: 0.25, dashMm: LINE_DASH_PATTERNS[id] } }]).text, 'LINE')[0];
    expect(field(record, 6)).toBe(name);
  });
  it('一般曲線をR12 POLYLINE/VERTEXに分け、新しい実体を入れない', () => {
    const curve: RenderPath = { ...line, subpaths: [{ commands: [{ kind: 'M', to: [0, 0] },
      { kind: 'C', control1: [0, 10], control2: [10, 10], to: [10, 0] }] }] };
    const result = output([curve]); expect(result.flattenedCurveCount).toBe(1); expect(records(result.text, 'POLYLINE')).toHaveLength(1);
    expect(records(result.text, 'VERTEX').length).toBeGreaterThan(10); expect(records(result.text, 'LWPOLYLINE')).toHaveLength(0);
  });
  it('ハッチングの線群をLINEとして保存しHATCHを作らない', () => {
    const value = output([line, { ...line, transform: [1, 0, 0, 1, 0, 5] }]).text;
    expect(records(value, 'LINE')).toHaveLength(2); expect(records(value, 'HATCH')).toHaveLength(0);
  });
  it('用紙上のクリップ境界で線を切る', () => {
    const result = output([{ ...line, clip: { fillRule: 'nonzero', transform: [1, 0, 0, 1, 0, 0], subpaths: [{ commands: [
      { kind: 'M', to: [30, 0] }, { kind: 'L', to: [90, 0] }, { kind: 'L', to: [90, 50] }, { kind: 'L', to: [30, 50] }, { kind: 'Z' },
    ] }] } }]);
    const record = records(result.text, 'LINE')[0]; expect(field(record, 10)).toBe('30'); expect(field(record, 11)).toBe('90');
  });
  it('表せない白抜きを黒い塗りへ変えず省略件数を返す', () => {
    const result = output([line, { ...arrow, fill: '#ffffff' }]); expect(result.skippedPrimitiveCount).toBe(1);
    expect(records(result.text, 'LINE')).toHaveLength(1); expect(records(result.text, 'SOLID')).toHaveLength(0);
  });
  it('未知のレイヤーは無言で0層へ落とさず省略を報告する', () => {
    expect(output([{ ...line, layerId: 'missing' }]).skippedPrimitiveCount).toBe(1);
  });
  it('任意RGBのACI近似と線幅を保存できないことを返す', () => {
    const result = output([{ ...line, stroke: { color: '#123456', widthMm: 0.5, dashMm: [] } }]);
    expect(result.approximatedColorCount).toBe(1); expect(result.lineWidthsPreserved).toBe(false);
    expect(parseDxfTags(result.text).some((tag) => tag.code === 370 || tag.code === 420)).toBe(false);
  });
  it('レイヤー自体の色を近似した場合も件数へ含む', () => {
    expect(output([], [{ ...layers[0], color: '#123456' }]).approximatedColorCount).toBe(1);
  });
  it('黒い外周線の内側の塗り色の近似も件数へ含む', () => {
    const result = output([{ ...arrow, fill: '#fe8023', stroke: line.stroke }]);
    expect(result.approximatedColorCount).toBe(1); expect(result.skippedPrimitiveCount).toBe(0);
    expect(records(result.text, 'SOLID')).toHaveLength(1);
  });
  it('同じ入力から同じバイト列になる', () => { expect(output([line, text, arrow])).toEqual(output([line, text, arrow])); });
  it('空の図面でも全レイヤーと終端がある', () => {
    const result = output([]); expect(result.skippedPrimitiveCount).toBe(0); expect(records(result.text, 'LAYER')).toHaveLength(8);
  });
});
