/**
 * 規格部品の選ぶ窓の寸法の図(K-07c)の線図: 最初の押し出しの面のスケッチ(xy)の線と弧だけを、窓の枠(220×140 px)に縦横同じ縮尺で収めて描く事。
 * 基本の形で作る部品・xy 以外の作図面の部品は描かない事。円弧の範囲は通る 0・90・180・270 度の点まで含める事。同じ鍵は作り直さない事。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, ALL_STEEL_PRODUCTS, appendFeature, appendSolid, buildStandardPart, createEmptyPartDocument,
  type PartDocument, replaceSketch, type SketchFeature, steelProductOptions,
} from '@pointercad/model';
import { describe, expect, it, vi } from 'vitest';

import { cachedPartOutline } from './partOutline.js';

const line = (id: string, from: readonly [number, number], to: readonly [number, number]): SketchFeature => ({
  id, name: id, planeId: 'xy', kind: 'line', construction: false,
  from: absoluteCoordinate(from[0], from[1], 0), to: absoluteCoordinate(to[0], to[1], 0),
});
const arc = (id: string, center: readonly [number, number], radius: number, startDegrees: number, endDegrees: number): SketchFeature => ({
  id, name: id, planeId: 'xy', kind: 'arc', construction: false, center: absoluteCoordinate(center[0], center[1], 0),
  radius: expressionValueFromNumber(radius), startAngle: expressionValueFromNumber(startDegrees), endAngle: expressionValueFromNumber(endDegrees),
});
const face = (id: string, boundary: readonly string[]): SketchFeature => ({
  id, name: id, planeId: 'xy', kind: 'face', color: '#888888', boundary: boundary.map((featureId) => ({ featureId })),
});

/** 線と弧と面のスケッチを 1 本作り、最初の面を押し出した部品文書。 */
function extruded(features: readonly SketchFeature[]): PartDocument {
  const empty = createEmptyPartDocument();
  const sketch = features.reduce((current, feature) => appendFeature(current, feature), empty.sketches[0]);
  const profile = features.find((feature) => feature.kind === 'face');
  if (profile === undefined) throw new Error('面が無い');
  return appendSolid(replaceSketch(empty, sketch), { id: 'extrude-1', name: '押し出し 1', suppressed: false, kind: 'extrude',
    profile: { sketchId: sketch.id, faceFeatureId: profile.id }, distance: expressionValueFromNumber(10), reversed: false, symmetric: false });
}

/** L 字(幅 40・高さ 30)と、全周の円(1 本の円弧)の穴の面。 */
const L_WITH_HOLE: readonly SketchFeature[] = [
  line('l1', [0, 0], [40, 0]), line('l2', [40, 0], [40, 10]), line('l3', [40, 10], [10, 10]), line('l4', [10, 10], [10, 30]),
  line('l5', [10, 30], [0, 30]), line('l6', [0, 30], [0, 0]), face('f1', ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']),
  arc('c1', [25, 5], 3, 0, 360), face('f2', ['c1']),
];

const commandCount = (path: string, command: string): number => path.split(' ').filter((token) => token === command).length;

describe('線図(cachedPartOutline)', () => {
  it('L 字と全周の円の穴: 輪ごとに 1 本、全周の円は半円 2 つ、外形の幅と高さ、枠に縦横同じ縮尺で収める', () => {
    const outline = cachedPartOutline('test:l-with-hole', () => extruded(L_WITH_HOLE));
    expect(outline).not.toBeNull();
    if (outline === null) return;
    expect(outline.paths).toHaveLength(2);
    for (const path of outline.paths) expect(path.startsWith('M ') && path.endsWith(' Z')).toBe(true);
    expect(commandCount(outline.paths[0], 'L')).toBe(6);
    expect(commandCount(outline.paths[1], 'A')).toBe(2);
    expect(outline.widthLine.valueMm).toBe(40);
    expect(outline.heightLine.valueMm).toBe(30);
    // 縮尺は min(220/40, 140/30) = 140/30。幅 = 8 + 40×140/30 + 64 を切り上げ、高さ = 8 + 140 + 30。
    expect(outline.viewWidth).toBe(Math.ceil(8 + 40 * 140 / 30 + 64));
    expect(outline.viewHeight).toBe(178);
    // 左下の角(0,0)は余白の内側の左下(8, 8 + 140)。
    expect(outline.paths[0]).toContain('8 148');
  });

  it('半円の高さは半径(円弧が通る 90 度の点まで範囲に入れる。端の点だけなら 0 になる所)', () => {
    const outline = cachedPartOutline('test:half-disc', () => extruded([
      arc('a1', [0, 0], 10, 0, 180), line('l1', [-10, 0], [10, 0]), face('f1', ['a1', 'l1']),
    ]));
    expect(outline?.widthLine.valueMm).toBe(20);
    expect(outline?.heightLine.valueMm).toBeCloseTo(10, 12);
  });

  it('作図面が xy でないスケッチは描かない', () => {
    const tilted = L_WITH_HOLE.map((feature): SketchFeature => ({ ...feature, planeId: 'xz' }));
    expect(cachedPartOutline('test:tilted', () => extruded(tilted))).toBeNull();
  });

  it('最初の立体が基本の形の部品(深溝玉軸受)と、作れない部品は描かない', () => {
    expect(cachedPartOutline('test:bearing', () => buildStandardPart('deepGrooveBallBearing', '6000'))).toBeNull();
    expect(cachedPartOutline('test:missing', () => null)).toBeNull();
  });

  it('実物: 材質別の等辺山形鋼 L 40×40×5 は輪 1 本(丸み 3 つ)で、幅と高さが 40', () => {
    const row = ALL_STEEL_PRODUCTS.find((candidate) => candidate.key === 'SS400:equalAngle:L 40×40×5');
    expect(row).toBeDefined();
    if (row === undefined) return;
    const outline = cachedPartOutline('test:angle', () => buildStandardPart(row.catalog, row.size, { ...steelProductOptions(row), length: '1000' }));
    expect(outline?.paths).toHaveLength(1);
    expect(commandCount(outline?.paths[0] ?? '', 'A')).toBe(3);
    expect(outline?.widthLine.valueMm).toBeCloseTo(40, 9);
    expect(outline?.heightLine.valueMm).toBeCloseTo(40, 9);
  });

  it('同じ鍵では部品文書を作り直さない', () => {
    const build = vi.fn(() => extruded(L_WITH_HOLE));
    const first = cachedPartOutline('test:cache', build);
    expect(cachedPartOutline('test:cache', build)).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
