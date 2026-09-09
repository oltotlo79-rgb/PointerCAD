import { describe, expect, it } from 'vitest';
import { renderDrawing, type DrawingRenderElement } from './renderDrawing.js';
import { DEFAULT_DRAWING_LAYERS } from '../style/layers.js';
import type { DrawingDocument, DrawingView } from '../types.js';
import type { OutlinedText } from '../text/fontStore.js';
import { toSvg } from './toSvg.js';

function document(patch: Partial<DrawingDocument> = {}): DrawingDocument {
  return { id: 'drawing', name: '図面', schemaVersion: 9,
    source: { sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' },
    sheet: { paperSizeId: 'A3-landscape', orientation: 'landscape', scale: 1, projectionMethod: 'third', frame: { visible: true },
      titleBlock: { title: '部品図', drawingNumber: 'A-001', revision: '1', author: '作成者', date: '2026-09-09', material: 'アルミ' } },
    views: [], dimensions: [], annotations: [], tables: [], balloons: [], layers: DEFAULT_DRAWING_LAYERS, parameters: [], ...patch };
}
function outlineText(text: string, sizeMm: number): OutlinedText {
  return { status: 'ready', missingCharacters: [], fillRule: 'nonzero',
    metrics: { fontId: 'fixture-font', sizeMm, advanceMm: text.length * sizeMm,
      inkBounds: { left: 0, right: text.length * sizeMm, bottom: 0, top: sizeMm } },
    subpaths: [{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [sizeMm, 0] },
      { kind: 'L', to: [sizeMm, sizeMm] }, { kind: 'L', to: [0, sizeMm] }, { kind: 'Z' }] }] };
}
const view: DrawingView = { id: 'front', name: '正面', kind: 'front', position: [100, 100], scale: null,
  direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const segment = { kind: 'segment' as const, from: [10, 20] as const, to: [30, 40] as const };
const line: DrawingRenderElement = { ownerId: 'line', layerId: 'layer-1', curves: [segment] };
const render = (doc = document(), elements: readonly DrawingRenderElement[] = [line], forPrint = false) =>
  renderDrawing({ document: doc, views: [], elements }, { outlineText, forPrint });

describe('用紙と解決済みの形状を同じ中間表現へ写す(P8-41)', () => {
  it('A3横は420×297mmで枠4本と中心マーク4本を持つ', () => {
    const result = render(document(), []);
    expect(result.document).toMatchObject({ widthMm: 420, heightMm: 297 });
    expect(result.document.primitives.filter((primitive) => primitive.ownerId === 'drawing:frame')).toHaveLength(8);
  });
  it('枠なしでも表題欄は残る', () => {
    const original = document();
    const result = render({ ...original, sheet: { ...original.sheet, frame: { visible: false } } });
    expect(result.document.primitives.some((primitive) => primitive.ownerId === 'drawing:frame')).toBe(false);
    expect(result.document.primitives.some((primitive) => primitive.ownerId === 'drawing:title')).toBe(true);
  });
  it('左下原点の紙上mmを変換せず保持する', () => {
    expect(render().document.primitives.find((primitive) => primitive.ownerId === 'line')).toMatchObject({
      kind: 'path', transform: [1, 0, 0, 1, 0, 0], subpaths: [{ commands: [{ kind: 'M', to: [10, 20] }, { kind: 'L', to: [30, 40] }] }],
    });
  });
  it('用紙外の線を捨てない', () => {
    const result = render(document(), [{ ...line, curves: [{ ...segment, from: [-100, -100], to: [600, 600] }] }]);
    expect(result.document.primitives.find((primitive) => primitive.ownerId === 'line')).toBeDefined();
  });
  it('非表示レイヤーの形は印刷でも画面でも出ない', () => {
    const doc = document({ layers: DEFAULT_DRAWING_LAYERS.map((layer) => ({ ...layer, visible: layer.id !== 'layer-1' })) });
    for (const forPrint of [false, true]) expect(render(doc, [line], forPrint).document.primitives.some((primitive) => primitive.ownerId === 'line')).toBe(false);
  });
  it('印刷しないレイヤーは画面だけに出る', () => {
    const doc = document({ layers: DEFAULT_DRAWING_LAYERS.map((layer) => ({ ...layer, printable: layer.id !== 'layer-1' })) });
    expect(render(doc).document.primitives.some((primitive) => primitive.ownerId === 'line')).toBe(true);
    expect(render(doc, [line], true).document.primitives.some((primitive) => primitive.ownerId === 'line')).toBe(false);
  });
  it('要素の線色・線幅・線種を継承より優先する', () => {
    const result = render(document(), [{ ...line, style: { color: '#ff0000', lineWidth: 0.7, lineType: 'dashed' } }]);
    expect(result.document.primitives.find((primitive) => primitive.ownerId === 'line')).toMatchObject({ stroke: { color: '#ff0000', widthMm: 0.7, dashMm: [3, 1] } });
  });
  it('図の実線と隠れ線が同じ配列へ入る', () => {
    const result = renderDrawing({ document: document({ views: [view] }), views: [{ viewId: 'front',
      visible: [{ curve: segment }], hidden: [{ curve: segment }], cuttingCurves: [] }] }, { outlineText });
    const curves = result.document.primitives.filter((primitive) => primitive.ownerId === 'front');
    expect(curves.map((primitive) => primitive.layerId)).toEqual(['layer-1', 'layer-2']);
    expect(curves[1]).toMatchObject({ stroke: { dashMm: [3, 1] } });
  });
  it('隠れ線の表示を切ると出力からも除く', () => {
    const result = renderDrawing({ document: document({ views: [{ ...view, showHidden: false }] }), views: [{ viewId: 'front',
      visible: [], hidden: [{ curve: segment }], cuttingCurves: [] }] }, { outlineText });
    expect(result.document.primitives.some((primitive) => primitive.ownerId === 'front')).toBe(false);
  });
  it('円弧をC命令へ変換し入口の座標を維持する', () => {
    const result = render(document(), [{ ...line, curves: [{ kind: 'arc', center: [10, 10], radius: 5, startAngle: 0, endAngle: Math.PI / 2 }] }]);
    const arc = result.document.primitives.find((primitive) => primitive.ownerId === 'line');
    if (arc?.kind !== 'path') throw new Error('円弧がない');
    expect(arc.subpaths[0].commands[0]).toEqual({ kind: 'M', to: [15, 10] });
    expect(arc.subpaths[0].commands.slice(1).every((command) => command.kind === 'C')).toBe(true);
  });
  it('文字の実測値と穴を含む輪郭を保持する', () => {
    const text: DrawingRenderElement = { ownerId: 'dimension', layerId: 'layer-4', texts: [{ text: '20', position: [30, 60], sizeMm: 3.5, angle: Math.PI / 2, anchor: 'middle' }] };
    const result = render(document(), [text]);
    expect(result.document.primitives.find((primitive) => primitive.ownerId === 'dimension')).toMatchObject({
      kind: 'text', text: '20', position: [30, 60], angle: Math.PI / 2, anchor: 'middle', metrics: outlineText('20', 3.5).metrics,
      outline: outlineText('20', 3.5).subpaths,
    });
  });
  it('輪郭の穴とクリップを一つの複合パスとして保持する', () => {
    const outline = outlineText('8', 3.5).subpaths;
    const clip = { subpaths: outline, fillRule: 'evenodd' as const, transform: [1, 0, 0, 1, 0, 0] as const };
    const result = render(document(), [{ ownerId: 'fill', layerId: 'layer-4', fills: [{ subpaths: [...outline, ...outline], fillRule: 'evenodd' }], clip }]);
    expect(result.document.primitives.find((primitive) => primitive.ownerId === 'fill')).toMatchObject({
      kind: 'path', fillRule: 'evenodd', clip, stroke: null, subpaths: [...outline, ...outline],
    });
  });
  it('字体未読込を問題として返し、印刷へ代替字形を入れない', () => {
    const result = renderDrawing({ document: document(), views: [] }, { forPrint: true,
      outlineText: (text, size) => ({ ...outlineText(text, size), status: 'unloaded', metrics: null }) });
    expect(result.issues.some((issue) => issue.kind === 'font')).toBe(true);
    expect(result.document.primitives.some((primitive) => primitive.kind === 'text')).toBe(false);
  });
  it('存在しないレイヤーを外形線へ勝手に割り当てない', () => {
    expect(render(document(), [{ ...line, layerId: 'missing' }]).issues).toContainEqual({ ownerId: 'line', kind: 'layer' });
  });
  it('不正な幾何を報告し、NaNを出口へ流さない', () => {
    const result = render(document(), [{ ...line, curves: [{ ...segment, from: [NaN, 0] }] }]);
    expect(result.issues).toContainEqual({ ownerId: 'line', kind: 'geometry' });
    expect(result.document.primitives.some((primitive) => primitive.ownerId === 'line')).toBe(false);
  });
  it('一般公差を表題欄の上に配置する', () => {
    const doc = document();
    const result = render({ ...doc, sheet: { ...doc.sheet, generalTolerance: 'm' } });
    expect(result.document.primitives.find((primitive) => primitive.ownerId === 'drawing:generalTolerance')).toMatchObject({
      text: '指示なき寸法の普通公差 JIS B 0405-中級(m)', position: [410, 69.5], anchor: 'end',
    });
  });
  it('同じ入力の出力は配列順も完全に一致し、入力を変えない', () => {
    const doc = document(); const before = JSON.stringify(doc);
    expect(render(doc)).toEqual(render(doc));
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('長い日本語図名は2.5mm以上で折り返し、文字を落とさない', () => {
    const base = document(), title = '工作機械用の長い日本語部品名称をここへ記載する';
    const result = render({ ...base, sheet: { ...base.sheet, titleBlock: { ...base.sheet.titleBlock, title } } });
    const rows = result.document.primitives.filter((item) => item.kind === 'text' && title.includes(item.text) && item.text.length > 1);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((item) => item.kind === 'text' ? item.text : '').join('')).toBe(title);
    expect(result.document.primitives.every((item) => item.kind !== 'text' || item.metrics.sizeMm >= 2.5)).toBe(true);
    expect(result.issues).toEqual([]);
  });
  it('表題欄に入り切らない文字列は出力を止める問題として返す', () => {
    const base = document(), title = 'あ'.repeat(200);
    expect(render({ ...base, sheet: { ...base.sheet, titleBlock: { ...base.sheet.titleBlock, title } } }).issues)
      .toContainEqual({ ownerId: 'drawing:title', kind: 'geometry', text: title });
  });
  it('共通SVG出口へ直接渡して日本語文字の輪郭を出力できる(P8-43)', () => {
    const result = render();
    expect(result.issues).toEqual([]);
    const svg = toSvg(result.document);
    expect(svg).toContain('width="420mm"');
    expect(svg).toContain('height="297mm"');
    expect(svg).not.toContain('<text');
  });
});
