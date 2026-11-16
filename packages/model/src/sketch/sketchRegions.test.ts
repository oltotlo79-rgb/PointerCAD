import { expressionValueFromNumber as num } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { absoluteCoordinate } from './createSketchDocument.js';
import { resolveSketch } from './resolveSketch.js';
import { findSketchRegions, regionAtPoint } from './sketchRegions.js';
import type { SketchDocument, SketchFeature } from './types.js';
import type { Vec3 } from './vec3.js';

// M-01 面を張らずに押し出す: 作図面の上の、曲線の全体だけでできた閉じた輪を領域として探す(保存はしない)。
function documentOf(...features: SketchFeature[]): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features };
}
function line(id: string, from: Vec3, to: Vec3, construction = false): SketchFeature {
  return { id, name: id, planeId: 'xy', kind: 'line', from: absoluteCoordinate(...from), to: absoluteCoordinate(...to), construction };
}
function rectangle(id: string, corner1: Vec3, corner2: Vec3, construction = false): SketchFeature {
  return { id, name: id, planeId: 'xy', kind: 'rectangle', corner1: absoluteCoordinate(...corner1), corner2: absoluteCoordinate(...corner2), construction };
}
function circle(id: string, center: Vec3, radius: number, construction = false): SketchFeature {
  return { id, name: id, planeId: 'xy', kind: 'arc', center: absoluteCoordinate(...center), radius: num(radius),
    startAngle: num(0), endAngle: num(360), construction };
}
function regionsOf(document: SketchDocument) {
  return findSketchRegions(document, resolveSketch(document));
}

describe('閉じた輪を領域として探す(M-01)', () => {
  it('矩形 1 つは 1 つの領域になり、境界は面の道具で矩形を押した時と同じ参照 1 つ(index なし)になる', () => {
    const result = regionsOf(documentOf(rectangle('rectangle-1', [0, 0, 0], [60, 40, 0])));
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].boundary).toEqual([{ featureId: 'rectangle-1' }]);
    expect(result.regions[0].holes).toEqual([]);
    expect(result.regions[0].area).toBeCloseTo(2400, 6);
  });

  it('円 1 つは 1 本で輪の領域になる', () => {
    const result = regionsOf(documentOf(circle('arc-1', [0, 0, 0], 5)));
    expect(result.regions.map(region => region.boundary)).toEqual([[{ featureId: 'arc-1' }]]);
    // 面積は標本の折れ線の近似(内接する多角形なので、真の値より少し小さい)。
    expect(result.regions[0].area).toBeGreaterThan(0.99 * Math.PI * 25);
    expect(result.regions[0].area).toBeLessThanOrEqual(Math.PI * 25);
  });

  it('端でつながる線分の多角形は、たどる順に並べた輪になる(かいた順に依らない)', () => {
    const result = regionsOf(documentOf(
      line('line-1', [0, 0, 0], [10, 0, 0]), line('line-3', [10, 10, 0], [0, 0, 0]), line('line-2', [10, 0, 0], [10, 10, 0])));
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].boundary.map(ref => ref.featureId)).toEqual(['line-1', 'line-2', 'line-3']);
  });

  it('開いた折れ線と構築線は領域にしない', () => {
    const open = regionsOf(documentOf(line('line-1', [0, 0, 0], [10, 0, 0]), line('line-2', [10, 0, 0], [10, 10, 0])));
    expect(open.regions).toEqual([]);
    const construction = regionsOf(documentOf(rectangle('rectangle-1', [0, 0, 0], [10, 10, 0], true)));
    expect(construction.regions).toEqual([]);
  });

  it('矩形の中の円は、矩形の領域の穴の候補と、円の領域の 2 つになる', () => {
    const result = regionsOf(documentOf(rectangle('rectangle-1', [0, 0, 0], [60, 40, 0]), circle('arc-1', [30, 20, 0], 5)));
    const outer = result.regions.find(region => region.boundary[0].featureId === 'rectangle-1');
    const inner = result.regions.find(region => region.boundary[0].featureId === 'arc-1');
    expect(result.regions).toHaveLength(2);
    expect(outer?.holes).toEqual([[{ featureId: 'arc-1' }]]);
    expect(inner?.holes).toEqual([]);
  });

  it('交わる矩形と円は領域にせず、交わる曲線を理由として返す(分割・トリムへ案内するため)', () => {
    const result = regionsOf(documentOf(rectangle('rectangle-1', [0, 0, 0], [60, 40, 0]), circle('arc-1', [60, 20, 0], 5)));
    expect(result.regions).toEqual([]);
    expect([...result.crossingFeatureIds].sort()).toEqual(['arc-1', 'rectangle-1']);
  });

  it('端点のずれが許容差の内なら輪になり、外なら輪にならない', () => {
    const near = regionsOf(documentOf(
      line('line-1', [0, 0, 0], [10, 0, 0]), line('line-2', [10, 0, 0], [10, 10, 0]), line('line-3', [10, 10, 0], [0, 5e-7, 0])));
    expect(near.regions).toHaveLength(1);
    const far = regionsOf(documentOf(
      line('line-1', [0, 0, 0], [10, 0, 0]), line('line-2', [10, 0, 0], [10, 10, 0]), line('line-3', [10, 10, 0], [0, 1e-3, 0])));
    expect(far.regions).toEqual([]);
  });

  // 3 点は必ず 1 つの平面に乗るので、平面に乗らない輪は 4 点でつくる(1 点だけ z を上げる)。
  it('作図面に乗らない 3D の曲線があれば、領域を出さない', () => {
    const result = regionsOf(documentOf(
      line('line-1', [0, 0, 0], [10, 0, 0]), line('line-2', [10, 0, 0], [10, 10, 5]),
      line('line-3', [10, 10, 5], [0, 10, 0]), line('line-4', [0, 10, 0], [0, 0, 0])));
    expect(result.regions).toEqual([]);
    expect(result.frame).toBeNull();
  });

  it('押した点を含むいちばん内側の領域を引く(円の内側は円の領域、矩形の残りは矩形の領域)', () => {
    const document = documentOf(rectangle('rectangle-1', [0, 0, 0], [60, 40, 0]), circle('arc-1', [30, 20, 0], 5));
    const result = regionsOf(document);
    expect(regionAtPoint(result, [30, 20, 0])?.boundary[0].featureId).toBe('arc-1');
    expect(regionAtPoint(result, [5, 5, 0])?.boundary[0].featureId).toBe('rectangle-1');
    expect(regionAtPoint(result, [100, 100, 0])).toBeNull();
  });

  // 時間の上限は単体に書かない(外部検査の負荷で揺れるため。2026-11-14 の検査の安定化の決まり)。数だけを確かめる。
  it('離れた矩形 20 個(曲線 80 本)は 20 の領域になる', () => {
    const features = Array.from({ length: 20 }, (_, index) =>
      rectangle(`rectangle-${String(index + 1)}`, [index * 20, 0, 0], [index * 20 + 10, 10, 0]));
    expect(regionsOf(documentOf(...features)).regions).toHaveLength(20);
  });
});
