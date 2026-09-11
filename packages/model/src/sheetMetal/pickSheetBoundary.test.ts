import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../sketch/vec3.js';
import { pickSheetBoundary } from './pickSheetBoundary.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';

const points: readonly Vec3[] = [[0, 0, 0], [50, 0, 0], [50, 30, 0], [0, 30, 0]];
const body: ResolvedSheetBody = { rootFeatureId: 'base', rule: { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) }, bends: [],
  panels: [{ id: 'panel', normal: [0, 0, 1], holes: [], outer: points.map((from, i) => ({ kind: 'segment', featureId: `side${i}`, from, to: points[(i + 1) % 4] })) }] };
describe('板金の実稜線から保存する縁を選ぶ', () => {
  it('上下どちらの稜線でも、端点の向きによらず同じ境界へ写す', () => {
    const lower = pickSheetBoundary(body, [0, 0, 0], [50, 0, 0]);
    expect(lower).toEqual([{ panelId: 'panel', boundaryId: '["sheet-edge","side0",0]' }]);
    expect(pickSheetBoundary(body, [50, 0, 2], [0, 0, 2])).toEqual(lower);
  });
  it('板厚側面の短辺、途中の部分、非有限値を元の全境界に誤認しない', () => {
    expect(pickSheetBoundary(body, [0, 0, 0], [0, 0, 2])).toEqual([]);
    expect(pickSheetBoundary(body, [0, 0, 0], [20, 0, 0])).toEqual([]);
    expect(pickSheetBoundary(body, [NaN, 0, 0], [50, 0, 0])).toEqual([]);
  });
  it('反転基板では負の板厚側の縁を写し、無関係な高さは断る', () => {
    const reversed = { ...body, panels: [{ ...body.panels[0], normal: [0, 0, -1] as const }] };
    expect(pickSheetBoundary(reversed, [50, 0, -2], [0, 0, -2])).toHaveLength(1);
    expect(pickSheetBoundary(reversed, [50, 0, 2], [0, 0, 2])).toEqual([]);
  });
  it('曖昧な重複パネルは候補を全て返し、先頭に勝手に決めない', () => {
    const ambiguous = { ...body, panels: [...body.panels, { ...body.panels[0], id: 'other-panel' }] };
    expect(pickSheetBoundary(ambiguous, [0, 0, 0], [50, 0, 0])).toHaveLength(2);
  });
});
