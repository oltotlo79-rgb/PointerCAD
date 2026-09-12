import { describe, expect, it } from 'vitest';
import { toSvg } from './toSvg.js';
import { bezierArc } from './bezierArc.js';
import type { RenderDocument, RenderPath, RenderText } from './types.js';
import { freezeFontSubpaths } from './immutableSubpaths.js';

const line: RenderPath = {
  kind: 'path', subpaths: [{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [50, 0] }] }],
  fillRule: 'nonzero', fill: null, stroke: { color: '#000000', widthMm: 0.5, dashMm: [] },
  clip: null, transform: [1, 0, 0, 1, 0, 0], ownerId: 'edge-1', layerId: 'visible',
};
const text: RenderText = {
  kind: 'text', text: '板厚', position: [20, 30], angle: 0, anchor: 'start', baseline: 'alphabetic',
  metrics: { fontId: 'noto-test', sizeMm: 3.5, advanceMm: 7,
    inkBounds: { left: 0, bottom: -0.3, right: 6.8, top: 3 } },
  outline: [{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [3, 0] }, { kind: 'L', to: [1, 2] }, { kind: 'Z' }] }],
  fill: '#111111', clip: null, transform: [1, 0, 0, 1, 0, 0], ownerId: 'note-1', layerId: 'notes',
};
const documentOf = (...primitives: RenderDocument['primitives']): RenderDocument => ({ widthMm: 420, heightMm: 297, primitives });

describe('SVG出力の座標・文字・安全性', () => {
  it('図の範囲は所有者とは別に保持し、属性へ混入する文字を拒否する', () => {
    expect(toSvg(documentOf({ ...line, viewId: 'parent"&' }))).toContain('data-view-id="parent&quot;&amp;"');
    expect(toSvg(documentOf({ ...line, viewId: 'parent\u0001' }))).toBeNull();
    expect(toSvg(documentOf(line))).not.toContain('data-view-id');
  });
  it('A3横の寸法とviewBoxはmmのまま', () => {
    expect(toSvg(documentOf(line))).toContain('width="420mm" height="297mm" viewBox="0 0 420 297"');
  });
  it('下端0を297、上端297を0へ写す反転を1回だけ行う', () => {
    const result = toSvg(documentOf(line));
    expect(result?.match(/translate\(0 297\) scale\(1 -1\)/gu)).toHaveLength(1);
    expect(result).toContain('d="M 0 0 L 50 0"');
    // y' = -y + 297なので(0,0)->(0,297)、(0,297)->(0,0)。
    expect([0, 297].map((y) => -y + 297)).toEqual([297, 0]);
  });
  it('線幅と破線のmmを縮尺で変えない', () => {
    const result = toSvg(documentOf({ ...line, stroke: { color: '#112233', widthMm: 0.5, dashMm: [3, 1] } }));
    expect(result).toContain('stroke="#112233" stroke-width="0.5" stroke-dasharray="3 1"');
  });
  it('円弧の3次ベジェを折れ線へ変えず出す', () => {
    const arc = bezierArc({ center: [10, 20], radius: 5, startAngle: 0, endAngle: Math.PI / 2 });
    if (arc === null) throw new Error('円弧がない');
    const result = toSvg(documentOf({ ...line, subpaths: [{ commands: [
      { kind: 'M', to: arc.start }, ...arc.segments.map((segment) => ({ kind: 'C' as const,
        control1: segment.control1, control2: segment.control2, to: segment.to })),
    ] }] }));
    expect(result).toContain('d="M 15 20 C ');
    expect(result).not.toContain(' L ');
  });
  it('外周と穴は同じpathの別subpathになる', () => {
    const result = toSvg(documentOf({ ...line, fill: '#333', stroke: null, fillRule: 'evenodd', subpaths: [
      { commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [10, 0] }, { kind: 'L', to: [5, 10] }, { kind: 'Z' }] },
      { commands: [{ kind: 'M', to: [3, 2] }, { kind: 'L', to: [7, 2] }, { kind: 'L', to: [5, 6] }, { kind: 'Z' }] },
    ] }));
    expect(result?.match(/<path /gu)).toHaveLength(1);
    expect(result).toContain('Z M 3 2');
    expect(result).toContain('fill-rule="evenodd"');
  });
  it('clipの座標変換と要素の所有者を保つ', () => {
    const result = toSvg(documentOf({ ...line, transform: [2, 0, 0, 2, 10, 20], clip: {
      subpaths: [{ commands: [{ kind: 'M', to: [1, 2] }, { kind: 'L', to: [4, 2] }, { kind: 'L', to: [1, 4] }, { kind: 'Z' }] }],
      fillRule: 'nonzero', transform: [1, 0, 0, 1, 3, 4],
    } }));
    expect(result).toContain('clipPathUnits="userSpaceOnUse"');
    expect(result).toContain('transform="matrix(1 0 0 1 3 4)"');
    expect(result).toContain('data-owner-id="edge-1" data-layer-id="visible" transform="matrix(2 0 0 2 10 20)" clip-path="url(#pcad-clip-0)"');
  });
  it('文字は既定で輪郭になり、日本語の意味も残す', () => {
    const result = toSvg(documentOf(text));
    expect(result).toContain('aria-label="板厚"');
    expect(result).toContain('translate(20 30) rotate(0) translate(0 0)');
    expect(result).not.toContain('<text');
    expect(result).not.toContain('font-family');
  });
  it('中央揃え・上端揃え・回転は実測値から変換する', () => {
    const result = toSvg(documentOf({ ...text, anchor: 'middle', baseline: 'top', angle: Math.PI / 2 }));
    expect(result).toContain('translate(20 30) rotate(90) translate(-3.5 -3)');
  });
  it('共有字形を再利用しても移動・回転・色・別の字形を最新値で出す', () => {
    const outline = freezeFontSubpaths(structuredClone(text.outline ?? []));
    const original = { ...text, outline };
    const first = toSvg(documentOf(original));
    expect(first).toContain('d="M 0 0 L 3 0 L 1 2 Z"');
    const moved = toSvg(documentOf({ ...original, position: [45, 60], angle: Math.PI / 2, fill: '#ff0000' }));
    expect(moved).toContain('translate(45 60) rotate(90)');
    expect(moved).toContain('fill="#ff0000"');
    expect(moved).toContain('d="M 0 0 L 3 0 L 1 2 Z"');
    const other = freezeFontSubpaths([{ commands: [{ kind: 'M', to: [2, 3] }, { kind: 'L', to: [9, 8] }] }]);
    expect(toSvg(documentOf({ ...original, outline: other }))).toContain('d="M 2 3 L 9 8"');
    expect(toSvg(documentOf(original))).toBe(first);
  });
  it('外から渡された可変字形の変更と非有限座標を、再出力時にも見落とさない', () => {
    const point: [number, number] = [3, 4];
    const mutable = { ...text, outline: [{ commands: [{ kind: 'M' as const, to: point }] }] };
    expect(toSvg(documentOf(mutable))).toContain('d="M 3 4"');
    point[0] = 6;
    expect(toSvg(documentOf(mutable))).toContain('d="M 6 4"');
    point[0] = Infinity;
    expect(toSvg(documentOf(mutable))).toBeNull();
  });
  it('輪郭未取得は既定で断り、明示指定なら編集できるtextを出す', () => {
    const document = documentOf({ ...text, outline: null });
    expect(toSvg(document)).toBeNull();
    expect(toSvg(document, { textMode: 'semantic' })).toContain('<text transform="scale(1 -1)" font-size="3.5"');
  });
  it('注記と所有者のタグ・引用符をエスケープする', () => {
    const result = toSvg(documentOf({ ...text, text: '<script>alert("x")</script>&', ownerId: '" onload="alert(1)' }), { textMode: 'semantic' });
    expect(result).not.toContain('<script>');
    expect(result).not.toContain(' onload="');
    expect(result).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;');
  });
  it.each(['url(https://example.test/color)', 'red" onload="x', 'var(--external)'])('外部資源や属性を色へ埋め込ませない: %s', (color) => {
    expect(toSvg(documentOf({ ...line, fill: color }))).toBeNull();
  });
  it('スクリプトや外部参照要素を生成しない', () => {
    const result = toSvg(documentOf(line, text));
    expect(result).not.toMatch(/<(?:script|image|use|link|foreignObject)\b/u);
    expect(result).not.toMatch(/\b(?:href|src)=|@import/u);
  });
  it.each([NaN, Infinity, 0, -1])('不正な用紙幅%sは断る', (widthMm) => {
    expect(toSvg({ ...documentOf(line), widthMm })).toBeNull();
  });
  it('非有限座標と先頭Mのないパスを断る', () => {
    expect(toSvg(documentOf({ ...line, subpaths: [{ commands: [{ kind: 'M', to: [NaN, 0] }] }] }))).toBeNull();
    expect(toSvg(documentOf({ ...line, subpaths: [{ commands: [{ kind: 'L', to: [0, 0] }] }] }))).toBeNull();
  });
  it('XMLに書けない文字を勝手に削らない', () => {
    expect(toSvg(documentOf({ ...text, text: String.fromCharCode(0) }))).toBeNull();
  });
  it('同じ入力の出力はIDも含め完全一致する', () => {
    expect(toSvg(documentOf(line, text))).toBe(toSvg(documentOf(line, text)));
  });
});
