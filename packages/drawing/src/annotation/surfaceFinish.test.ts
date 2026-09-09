import { describe, expect, it } from 'vitest';
import { surfaceFinish, type SurfaceFinishInput } from './surfaceFinish.js';
const input: SurfaceFinishInput = { process: 'basic', parameter: 'Ra', value: 3.2, position: [10, 20] };

describe('表面性状(P8-34)', () => {
  it('基本記号の開き角は60°で高さは7mm', () => {
    const result = surfaceFinish(input)!;
    expect(result.lines).toHaveLength(2);
    const a = result.lines[0].from.map((value, i) => value - input.position[i]);
    const b = result.lines[1].to.map((value, i) => value - input.position[i]);
    expect((a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b))).toBeCloseTo(0.5, 12);
    expect(result.lines[1].to[1] - input.position[1]).toBe(7);
    expect(result.arcs).toEqual([]);
  });
  it('除去加工は短い腕の高さで横棒を結ぶ', () => {
    const result = surfaceFinish({ ...input, process: 'removal' })!;
    expect(result.lines).toHaveLength(3);
    expect(result.lines[2].from).toEqual(result.lines[0].from);
    expect(result.lines[2].from[1]).toBe(result.lines[2].to[1]);
    expect(result.arcs).toEqual([]);
  });
  it('除去しない面は両腕の内側に接する円を持つ', () => {
    const result = surfaceFinish({ ...input, process: 'noRemoval' })!;
    expect(result.lines).toHaveLength(2);
    expect(result.arcs).toHaveLength(1);
    const circle = result.arcs[0];
    expect(circle.endAngle - circle.startAngle).toBe(2 * Math.PI);
    expect(circle.radius).toBeCloseTo((circle.center[1] - 20) / 2, 12);
  });
  it.each([['Ra', 3.2, 'Ra 3.2'], ['Rz', 12.5, 'Rz 12.5']] as const)('%sを左側に記入する', (parameter, value, text) => {
    const result = surfaceFinish({ ...input, parameter, value })!;
    expect(result.texts[0].text).toBe(text);
    expect(result.texts[0].anchor).toBe('end');
    expect(result.texts[0].position[0]).toBeLessThan(result.lines[0].from[0]);
  });
  it('文字高さの変更は記号の高さにも反映する', () => {
    expect(surfaceFinish({ ...input, sizeMm: 7 })?.lines[1].to[1]).toBe(34);
  });
  it('引出線は対象に矢印を置き、記号の下端までつながる', () => {
    const result = surfaceFinish({ ...input, target: [1, 2] })!;
    expect(result.leaderLines).toEqual([{ from: [1, 2], to: [10, 2] }, { from: [10, 2], to: [10, 20] }]);
    expect(result.leaderArrow?.points[0]).toEqual([1, 2]);
    expect(result.leaderArrow!.points[1][0]).toBeGreaterThan(1);
    expect(result.leaderArrow!.points[2][0]).toBeGreaterThan(1);
  });
  it('同じ点を指すときに長さ0の線や不正な矢印を作らない', () => {
    expect(surfaceFinish({ ...input, target: [10, 20] })).toMatchObject({ leaderLines: [], leaderArrow: null });
  });
  it('まとめ指示は実幅から括弧で囲み、引出線を付けない', () => {
    const result = surfaceFinish({ ...input, general: true, target: [1, 2], measureText: (_text, sizeMm) => ({
      fontId: 'test', sizeMm, advanceMm: 12, inkBounds: { left: -1, bottom: 0, right: 12, top: 3 },
    }) })!;
    expect(result.general).toBe(true);
    expect(result.texts.map((text) => text.text)).toEqual(['Ra 3.2', '(', ')']);
    expect(result.texts[1].position[0]).toBeCloseTo(result.texts[0].position[0] - 13 - 1.75, 12);
    expect(result.texts[2].position[0]).toBeGreaterThan(result.lines[1].to[0]);
    expect(result.leaderLines).toEqual([]);
  });
  it('字体を測れないまとめ指示は推測幅で作らない', () => {
    expect(surfaceFinish({ ...input, general: true })).toBeNull();
  });
  it('原点変更は全図形を平行移動する', () => {
    const first = surfaceFinish({ ...input, process: 'noRemoval', position: [0, 0] })!;
    const second = surfaceFinish({ ...input, process: 'noRemoval' })!;
    expect(second.arcs[0].center).toEqual([first.arcs[0].center[0] + 10, first.arcs[0].center[1] + 20]);
  });
  it.each([-1, NaN, Infinity])('不正な粗さ%sを断る', (value) => expect(surfaceFinish({ ...input, value })).toBeNull());
  it('0は受理する', () => expect(surfaceFinish({ ...input, value: 0 })?.texts[0].text).toBe('Ra 0'));
  it('不正な高さと座標を断る', () => {
    expect(surfaceFinish({ ...input, sizeMm: 0 })).toBeNull();
    expect(surfaceFinish({ ...input, position: [Infinity, 0] })).toBeNull();
    expect(surfaceFinish({ ...input, target: [0, NaN] })).toBeNull();
  });
});
