import { describe, expect, it } from 'vitest';
import { bezierArc } from './bezierArc.js';
import { toPdf } from './toPdf.js';
import type { RenderDocument, RenderPath, RenderText } from './types.js';

const stroke = { color: '#000000', widthMm: 0.5, dashMm: [] };
const outline: NonNullable<RenderText['outline']> = [{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [3, 0] }, { kind: 'L', to: [1, 3] }, { kind: 'Z' }] }];
const line: RenderPath = { kind: 'path', subpaths: [{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [100, 0] }] }],
  fillRule: 'nonzero', fill: null, stroke: { color: '#000000', widthMm: 0.5, dashMm: [] },
  transform: [1, 0, 0, 1, 0, 0], clip: null, ownerId: 'edge', layerId: 'visible' };
const text: RenderText = { kind: 'text', text: '板', position: [20, 30], angle: 0, anchor: 'start', baseline: 'alphabetic',
  metrics: { fontId: 'test', sizeMm: 3.5, advanceMm: 3.5, inkBounds: { left: 0, bottom: 0, right: 3.5, top: 3.5 } },
  outline: [{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [3, 0] }, { kind: 'L', to: [1, 3] }, { kind: 'Z' }] }],
  fill: '#000', clip: null, transform: [1, 0, 0, 1, 0, 0], ownerId: 'text', layerId: 'text' };
const documentOf = (...primitives: RenderDocument['primitives']): RenderDocument => ({ widthMm: 420, heightMm: 297, primitives });
function bytes(...primitives: RenderDocument['primitives']): Uint8Array {
  const result = toPdf(documentOf(...primitives)); if (!result.ok) throw new Error(result.reason); return result.bytes;
}
const source = (...primitives: RenderDocument['primitives']) => new TextDecoder('latin1').decode(bytes(...primitives));
const commands = (...primitives: RenderDocument['primitives']) => source(...primitives).split('\nstream\n')[1].split('\nendstream')[0];

describe('共通IRのPDF化(P8-46)', () => {
  it('100mmの長さをptへ変換する', () => expect(commands(line)).toContain('0.0000 0.0000 m\n283.4646 0.0000 l\nS'));
  it('0.5mmの線幅をptへ変換する', () => expect(commands(line)).toContain('1.4173 w'));
  it('破線の紙上長さを保つ', () => expect(commands({ ...line, stroke: { ...stroke, dashMm: [3, 1] } })).toContain('[8.5039 2.8346] 0 d'));
  it('半径10の円は紙上誤差0.001mmを満たす8曲線をPDFにも保つ', () => {
    const arc = bezierArc({ center: [0, 0], radius: 10, startAngle: 0, endAngle: 2 * Math.PI });
    if (arc === null) throw new Error('円弧なし');
    const output = commands({ ...line, subpaths: [{ commands: [{ kind: 'M', to: arc.start }, ...arc.segments.map((segment) => ({ kind: 'C' as const, ...segment }))] }] });
    expect(output.match(/ m\n/gu)).toHaveLength(1); expect(output.match(/ c\n/gu)).toHaveLength(8);
    // 4分割を固定していた旧前提を持ち込まない。PDFへ丸めた座標を独立に読む。
    const mm = 25.4 / 72;
    let from: readonly number[] = [10, 0];
    let maximumError = 0;
    for (const command of output.split('\n').filter((value) => value.endsWith(' c'))) {
      const values = command.split(' ').slice(0, 6).map((value) => Number(value) * mm);
      for (let step = 0; step <= 1000; step += 1) {
        const t = step / 1000, u = 1 - t;
        const x = u ** 3 * from[0] + 3 * u * u * t * values[0] + 3 * u * t * t * values[2] + t ** 3 * values[4];
        const y = u ** 3 * from[1] + 3 * u * u * t * values[1] + 3 * u * t * t * values[3] + t ** 3 * values[5];
        maximumError = Math.max(maximumError, Math.abs(Math.hypot(x, y) - 10));
      }
      from = values.slice(4);
    }
    expect(maximumError).toBeLessThanOrEqual(0.001);
  });
  it('文字は字体や画像を埋め込まず輪郭で塗る', () => {
    const result = source(text); expect(result).not.toContain('/Font'); expect(result).not.toContain('/Image');
    expect(commands(text)).toContain('\nh\nf\n');
  });
  it('輪郭のない文字を黙って消さない', () => expect(toPdf(documentOf({ ...text, outline: null })).ok).toBe(false));
  it('複合パスの穴を同じeven-oddの塗りに残す', () => {
    const output = commands({ ...line, fill: '#000', stroke: null, fillRule: 'evenodd', subpaths: [...outline, ...outline] });
    expect(output.match(/ m\n/gu)).toHaveLength(2); expect(output.match(/\nf\*\n/gu)).toHaveLength(1);
  });
  it('白い要素の白抜きを保持する', () => expect(commands({ ...text, fill: '#fff' })).toContain('1.0000 1.0000 1.0000 rg'));
  it('要素ごとのq/Qで破線やclipを次へ漏らさない', () => {
    const output = commands({ ...line, stroke: { ...stroke, dashMm: [3, 1] } }, line);
    expect(output.match(/^q$/gmu)).toHaveLength(2); expect(output.match(/^Q$/gmu)).toHaveLength(2);
    expect(output.split('\nQ\nq\n')[1]).not.toContain(' d');
  });
  it('clip自身の平行移動を紙上のパスへ適用する', () => {
    const output = commands({ ...line, clip: { subpaths: outline, fillRule: 'evenodd', transform: [1, 0, 0, 1, 3, 4] } });
    expect(output).toContain('8.5039 11.3386 m'); expect(output).toContain('W* n');
  });
  it('要素の拡大と移動は線幅にも適用するcm', () => expect(commands({ ...line, transform: [2, 0, 0, 2, 10, 20] })).toContain('2.0000 0.0000 0.0000 2.0000 28.3465 56.6929 cm'));
  it('文字の中央と下端は同じ実測値を使う', () => expect(commands({ ...text, anchor: 'middle', baseline: 'bottom' })).toContain('1 0 0 1 -4.9606 0.0000 cm'));
  it('文字の90度回転を保つ', () => expect(commands({ ...text, angle: Math.PI / 2 })).toContain('0.0000 1.0000 -1.0000 0.0000 56.6929 85.0394 cm'));
  it('空のIRでもPDFを開ける', () => expect(source()).toContain('/Length 0'));
  it('同じ図面で日時と乱数を補わず完全一致', () => expect(bytes(line, text)).toEqual(bytes(line, text)));
  it('不正な座標・色・破線で壊れた命令を書かない', () => {
    for (const value of [{ ...line, fill: 'url(secret)' }, { ...line, transform: [1, 0, 0, 1, Infinity, 0] as const },
      { ...line, stroke: { ...stroke, dashMm: [0, 0] } }]) expect(toPdf(documentOf(value)).ok).toBe(false);
  });
  it('A3のMediaBoxは1190.5512×841.8898pt', () => expect(source(line)).toContain('/MediaBox[0 0 1190.5512 841.8898]'));
  it('5000線のPDFを実測する(350KB±50%)', () => {
    const lines = Array.from({ length: 5000 }, (_, index): RenderPath => ({ ...line, ownerId: `line-${index}`, subpaths: [{ commands: [
      { kind: 'M', to: [index % 400, index % 280] }, { kind: 'L', to: [index % 400 + 10, index % 280 + 5] },
    ] }] }));
    const length = bytes(...lines).byteLength; console.log(`[P8 PDF] 5000線: ${length} bytes`);
    expect(length).toBeGreaterThanOrEqual(175_000); expect(length).toBeLessThanOrEqual(525_000);
  });
});
