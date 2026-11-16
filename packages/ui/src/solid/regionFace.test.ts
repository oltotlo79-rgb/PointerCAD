import { expressionValueFromNumber as num } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, createEmptyPartDocument, replaceSketch, resolveSketch,
  type PartDocument, type SketchFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import type { SolidInputCommit } from '../sketch/numericInput.js';
import { activeSketchHasRegions, appendRegionFace, pickExtrudeRegion } from './regionFace.js';
import { commitSolidInput, solidToolReadiness } from './solidCommands.js';

// M-01 面を張らずに押し出す: 領域を選び、押し出しの確定で、今の形の面と押し出しを 1 回で作る(保存の形は変えない)。
function rectangle(id: string, corner1: [number, number], corner2: [number, number]): SketchFeature {
  return { id, name: id, planeId: 'xy', kind: 'rectangle', corner1: absoluteCoordinate(corner1[0], corner1[1], 0),
    corner2: absoluteCoordinate(corner2[0], corner2[1], 0), construction: false };
}
function circle(id: string, center: [number, number], radius: number): SketchFeature {
  return { id, name: id, planeId: 'xy', kind: 'arc', center: absoluteCoordinate(center[0], center[1], 0), radius: num(radius),
    startAngle: num(0), endAngle: num(360), construction: false };
}
function partWith(...features: SketchFeature[]): PartDocument {
  const document = createEmptyPartDocument();
  return replaceSketch(document, features.reduce((sketch, feature) => appendFeature(sketch, feature), document.sketches[0]));
}
function activeSketch(document: PartDocument) {
  const sketch = document.sketches.find(candidate => candidate.id === document.activeSketchId);
  if (sketch === undefined) throw new Error('編集中のスケッチがありません');
  return sketch;
}
function extrudeCommit(overrides: Partial<SolidInputCommit> = {}): SolidInputCommit {
  return { kind: 'solid', tool: 'extrude', step: 'extrudeDistance', values: { distance: num(8) }, flags: { reversed: false, symmetric: false }, ...overrides };
}

describe('押した点から押し出す領域を選ぶ(M-01)', () => {
  it('矩形の内側を押すと、矩形の境界の領域を選ぶ', () => {
    const document = partWith(rectangle('rectangle-1', [0, 0], [60, 40]));
    const sketch = activeSketch(document);
    expect(pickExtrudeRegion(sketch, resolveSketch(sketch), [10, 10, 0]))
      .toEqual({ ok: true, region: { sketchId: sketch.id, planeId: 'xy', boundary: [{ featureId: 'rectangle-1' }] } });
  });

  it('穴の候補のある領域・交わる曲線・領域の外は、次にする操作が分かる理由で断る', () => {
    const holed = activeSketch(partWith(rectangle('rectangle-1', [0, 0], [60, 40]), circle('arc-1', [30, 20], 5)));
    expect(pickExtrudeRegion(holed, resolveSketch(holed), [5, 5, 0])).toEqual({ ok: false, reasonKey: 'solidError.regionHasHoles' });
    expect(pickExtrudeRegion(holed, resolveSketch(holed), [30, 20, 0]).ok).toBe(true);
    const crossing = activeSketch(partWith(rectangle('rectangle-1', [0, 0], [60, 40]), circle('arc-1', [60, 20], 5)));
    expect(pickExtrudeRegion(crossing, resolveSketch(crossing), [5, 5, 0])).toEqual({ ok: false, reasonKey: 'solidError.regionCrossing' });
    const plain = activeSketch(partWith(rectangle('rectangle-1', [0, 0], [60, 40])));
    expect(pickExtrudeRegion(plain, resolveSketch(plain), [100, 100, 0])).toEqual({ ok: false, reasonKey: 'solidError.regionNone' });
  });
});

describe('領域から面と押し出しを 1 回で作る(M-01)', () => {
  const region = { sketchId: 'sketch-1', planeId: 'xy', boundary: [{ featureId: 'rectangle-1' }] } as const;

  it('面は、面の道具で矩形を選んだ時と同じ中身(自動の名前・既定の色・境界)で足す', () => {
    const document = partWith(rectangle('rectangle-1', [0, 0], [60, 40]));
    const outcome = appendRegionFace(document, { ...region, sketchId: activeSketch(document).id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(activeSketch(outcome.document).features.at(-1)).toMatchObject({ id: outcome.faceElementId, kind: 'face', boundary: [{ featureId: 'rectangle-1' }] });
  });

  it('面を選ばずに領域で確定すると、1 つの文書に面と押し出しが積まれる(取り消しは 1 回)', () => {
    const document = partWith(rectangle('rectangle-1', [0, 0], [60, 40]));
    const sketchId = activeSketch(document).id;
    const outcome = commitSolidInput(document, [], extrudeCommit({ extrudeRegion: { ...region, sketchId } }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const face = activeSketch(outcome.document).features.find(feature => feature.kind === 'face');
    expect(face).toBeDefined();
    expect(outcome.document.solids.at(-1)).toMatchObject({ kind: 'extrude', profile: { sketchId, faceFeatureId: face?.id } });
    expect(document.solids).toHaveLength(0);
  });

  it('領域も面も無い確定は今までどおり断り、消えた要素を指す領域は古いとして断る', () => {
    const document = partWith(rectangle('rectangle-1', [0, 0], [60, 40]));
    expect(commitSolidInput(document, [], extrudeCommit())).toEqual({ ok: false, reasonKey: 'solidError.noFace' });
    const stale = { ...region, sketchId: activeSketch(document).id, boundary: [{ featureId: 'rectangle-9' }] };
    expect(commitSolidInput(document, [], extrudeCommit({ extrudeRegion: stale }))).toEqual({ ok: false, reasonKey: 'solidError.regionStale' });
  });
});

describe('押し出しの道具は、面を選んでいなくても閉じた領域があれば開ける(M-01)', () => {
  it('閉じた領域があれば開け、無ければ今までどおり「面が選ばれていません」で断る', () => {
    expect(solidToolReadiness(partWith(rectangle('rectangle-1', [0, 0], [60, 40])), [], 'extrude').ready).toBe(true);
    expect(activeSketchHasRegions(createEmptyPartDocument())).toBe(false);
    expect(solidToolReadiness(createEmptyPartDocument(), [], 'extrude')).toEqual({ ready: false, reasonKey: 'solidError.noFace' });
  });
});
