import { expressionValueFromNumber as num } from '@pointercad/expression';
import {
  absoluteCoordinate, addSketch, appendFeature, createEmptyPartDocument, createSketchFor, replaceSketch, resolvePart, resolveSketch,
  type PartDocument, type SketchDocument, type SketchFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { createNumericInput } from '../sketch/numericInput.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import { emphasisOf } from '../viewport/buildSketchGeometry.js';
import { solidEmphasisOf } from '../viewport/buildSolidGeometry.js';
import { extrudeTargetCandidates } from './extrudeOperation.js';
import type { SuggestionBody } from './extrudeSuggestion.js';
import { activeExtrudeRegions, clickExtrudeRegion, extrudeRegionHintKey, regionFillInputOf, regionHoverIdAt } from './regionPick.js';
import { commitSolidInput } from './solidCommands.js';

// M-01 の M01-3: 押し出しで面を選んでいない時だけ、作図面の閉じた領域を見せ、カーソルの下を濃くし、押して選ぶ。
function line(id: string, from: [number, number, number], to: [number, number, number]): SketchFeature {
  return { id, name: id, planeId: 'xy', kind: 'line', from: absoluteCoordinate(...from), to: absoluteCoordinate(...to), construction: false };
}
function square(prefix: string, x: number, y: number, size: number, z = 0): SketchFeature[] {
  const corners: [number, number, number][] = [[x, y, z], [x + size, y, z], [x + size, y + size, z], [x, y + size, z]];
  return corners.map((corner, index) => line(`${prefix}-${String(index + 1)}`, corner, corners[(index + 1) % 4]));
}
function circle(id: string, center: [number, number], radius: number): SketchFeature {
  return { id, name: id, planeId: 'xy', kind: 'arc', center: absoluteCoordinate(center[0], center[1], 0), radius: num(radius),
    startAngle: num(0), endAngle: num(360), construction: false };
}
function withFeatures(document: PartDocument, features: readonly SketchFeature[]): PartDocument {
  const sketch = activeSketch(document);
  return replaceSketch(document, features.reduce((current, feature) => appendFeature(current, feature), sketch));
}
function activeSketch(document: PartDocument): SketchDocument {
  const sketch = document.sketches.find(candidate => candidate.id === document.activeSketchId);
  if (sketch === undefined) throw new Error('編集中のスケッチがありません');
  return sketch;
}
/** 真上(z=100)から真下を向く視線。押した画素からの視線の代わり。 */
function down(x: number, y: number): { readonly origin: [number, number, number]; readonly direction: [number, number, number] } {
  return { origin: [x, y, 100], direction: [0, 0, -1] };
}
type ClickState = Parameters<typeof activeExtrudeRegions>[0] & { readonly bodies: readonly SuggestionBody[] };
function modeState(document: PartDocument, overrides: Partial<ClickState> = {}): ClickState {
  const sketch = activeSketch(document);
  return {
    activeTool: 'extrude', document, selection: [], sketch, resolvedSketch: resolveSketch(sketch), workPlaneId: 'xy', assembly: null,
    numericInput: createNumericInput('extrude', 'extrudeDistance', undefined, { extrudeTargets: extrudeTargetCandidates(document) }),
    hoveredElementId: null, bodies: [], ...overrides,
  };
}

describe('領域の id(ホバーの欄に入れる)', () => {
  it('境界の参照から作り、要素の id の区切り(#)を含まない', () => {
    const rectangle: SketchFeature = { id: 'rectangle-1', name: 'rectangle-1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(10, 10, 0), construction: false };
    const whole = activeExtrudeRegions(modeState(withFeatures(createEmptyPartDocument(), [rectangle])));
    expect(whole?.regions.map(region => region.elementId)).toEqual(['@region:rectangle-1']);
    const split = activeExtrudeRegions(modeState(withFeatures(createEmptyPartDocument(), [
      { ...rectangle, construction: true }, line('line-1', [0, 0, 0], [10, 0, 0]), line('line-2', [10, 0, 0], [10, 10, 0]),
      line('line-3', [10, 10, 0], [0, 0, 0])])));
    expect(split?.regions.map(region => region.elementId)).toEqual(['@region:line-1+line-2+line-3']);
  });

  it('ほかの読み手(木・部分形状・スケッチの強調)は、領域の id を要素の id と取り違えない', () => {
    const active = activeExtrudeRegions(modeState(withFeatures(createEmptyPartDocument(), square('line', 0, 0, 20))));
    const id = active?.regions[0]?.elementId ?? '';
    expect(id.startsWith('@region:')).toBe(true);
    // 木と文書の差し替え(documentDerived)は featureIdOf で引く。どの要素の id とも一致しない。
    expect(featureIdOf(id)).toBe(id);
    // 立体の部分形状の強調(buildSubShapeGeometry・viewFit)は parseSubShapeId で引く。
    expect(parseSubShapeId(id)).toBeNull();
    // スケッチの要素の強調は、要素の id か要素の持ち主の id と一致した時だけ。
    const highlight = { hoveredElementId: id, selection: [] };
    expect(emphasisOf('line-1', 'line-1', highlight, new Set())).toBe('none');
    expect(emphasisOf('line-1#0', 'line-1', highlight, new Set())).toBe('none');
    // 立体の強調は立体の id と一致した時だけ(領域の id は @region: で始まり、立体の id にならない)。
    expect(solidEmphasisOf('extrude-1', id, new Set())).toBe('none');
  });
});

describe('押し出しが領域を選ぶ状態か', () => {
  const document = withFeatures(createEmptyPartDocument(), square('line', 0, 0, 20));

  it('押し出しの欄を開き、面を選んでいない時だけ、領域と作図面を返す', () => {
    const active = activeExtrudeRegions(modeState(document));
    expect(active?.regions.map(region => region.elementId)).toEqual(['@region:line-1+line-2+line-3+line-4']);
    expect(active?.scan.frames).toHaveLength(1);
  });

  it('ほかの道具・3D スケッチ・組立の画面・欄が閉じている時は、領域を出さない', () => {
    expect(activeExtrudeRegions(modeState(document, { activeTool: 'select' }))).toBeNull();
    expect(activeExtrudeRegions(modeState(document, { workPlaneId: 'free' }))).toBeNull();
    expect(activeExtrudeRegions(modeState(document, { numericInput: null }))).toBeNull();
  });

  it('面を選んでいれば、今までどおり面で押し出す(領域を出さない)', () => {
    const faced = commitSolidInput(document, [], {
      kind: 'solid', tool: 'extrude', step: 'extrudeDistance', values: { distance: num(5) }, flags: { reversed: false, symmetric: false },
      extrudeRegion: { sketchId: activeSketch(document).id, planeId: 'xy', boundary: [{ featureId: 'line-1' }, { featureId: 'line-2' },
        { featureId: 'line-3' }, { featureId: 'line-4' }] },
    });
    if (!faced.ok) throw new Error(faced.reasonKey);
    const face = activeSketch(faced.document).features.find(feature => feature.kind === 'face');
    expect(activeExtrudeRegions(modeState(faced.document, { selection: [face?.id ?? ''] }))).toBeNull();
    // 面を選んで開いた押し出しでは、塗りの材料が無い(scene へ何も渡さず、描画の一式も枠に入れる対象も変わらない)。
    expect(regionFillInputOf(modeState(faced.document, { selection: [face?.id ?? ''] }))).toBeNull();
    expect(extrudeRegionHintKey(modeState(faced.document, { selection: [face?.id ?? ''] }))).toBeNull();
    // 面が張ってある領域は、面そのものを押せるので、塗りの対象から外す(二重に塗らない)。
    expect(activeExtrudeRegions(modeState(faced.document))?.regions).toEqual([]);
  });
});

describe('カーソルの下の領域と、押して選ぶ', () => {
  const holed = withFeatures(createEmptyPartDocument(), [...square('line', 0, 0, 60), circle('arc-1', [30, 30], 5)]);

  it('カーソルの下の、いちばん内側の領域だけを濃くする(板と穴を別に選ぶ)', () => {
    const active = activeExtrudeRegions(modeState(holed));
    if (active === null) throw new Error('領域を選ぶ状態になっていません');
    expect(regionHoverIdAt(active, down(30, 30))).toBe('@region:arc-1');
    expect(regionHoverIdAt(active, down(5, 5))).toBe('@region:line-1+line-2+line-3+line-4');
    expect(regionHoverIdAt(active, down(100, 100))).toBeNull();
  });

  it('押した領域の穴も欄に入れる。領域の外は理由で断る', () => {
    const state = modeState(holed);
    const picked = clickExtrudeRegion(state, down(30, 30));
    expect(picked?.kind).toBe('picked');
    if (picked?.kind !== 'picked') return;
    expect(picked.input.extrudeRegion?.boundary).toEqual([{ featureId: 'arc-1' }]);
    const plate = clickExtrudeRegion(state, down(5, 5));
    if (plate?.kind !== 'picked') throw new Error('穴つきの領域を選べません');
    expect(plate.input.extrudeRegion?.holes).toEqual([[{ featureId: 'arc-1' }]]);
    expect(regionFillInputOf(state)?.regions.find(region => region.elementId.includes('line-1'))?.holes).toHaveLength(1);
    expect(clickExtrudeRegion(state, down(100, 100))).toEqual({ kind: 'refused', reasonKey: 'solidError.regionNone' });
    expect(clickExtrudeRegion(modeState(holed, { activeTool: 'select' }), down(30, 30))).toBeNull();
  });

  it('領域を選ぶまでは欄に案内を出し、選んだ後は塗りで選んだ領域を示す', () => {
    const state = modeState(holed);
    expect(extrudeRegionHintKey(state)).toBe('numericInput.extrudeRegionPick');
    const picked = clickExtrudeRegion(state, down(30, 30));
    if (picked?.kind !== 'picked') throw new Error('選べませんでした');
    const chosen = { ...state, numericInput: picked.input, hoveredElementId: '@region:arc-1' };
    expect(extrudeRegionHintKey(chosen)).toBeNull();
    expect(regionFillInputOf(chosen)).toMatchObject({ hoveredElementId: '@region:arc-1', chosenElementId: '@region:arc-1' });
    expect(regionFillInputOf(modeState(holed, { activeTool: 'select' }))).toBeNull();
    // 要素のホバー(線分など)は領域の塗りの濃さに使わない。
    expect(regionFillInputOf({ ...state, hoveredElementId: 'line-1' })?.hoveredElementId).toBeNull();
  });
});

describe('1 つのスケッチに高さの違う作図面の領域がある時は、視線の手前の領域を選ぶ', () => {
  const layered = withFeatures(createEmptyPartDocument(), [...square('low', 0, 0, 10, 0), ...square('high', 0, 0, 10, 30),
    ...square('side', 20, 0, 10, 30)]);

  it('上から見ると高い方の領域、高い方の外なら低い方へ届かずに別の領域を選ぶ', () => {
    const active = activeExtrudeRegions(modeState(layered));
    if (active === null) throw new Error('領域を選ぶ状態になっていません');
    expect(active.scan.frames).toHaveLength(2);
    expect(regionHoverIdAt(active, down(5, 5))).toBe('@region:high-1+high-2+high-3+high-4');
    expect(regionHoverIdAt(active, down(25, 5))).toBe('@region:side-1+side-2+side-3+side-4');
    // 下から見上げると、手前は低い方。
    expect(regionHoverIdAt(active, { origin: [5, 5, -100], direction: [0, 0, 1] })).toBe('@region:low-1+low-2+low-3+low-4');
  });

  it('押した視線の手前の領域を欄に入れる(別の作図面の領域も押し出せる)', () => {
    const picked = clickExtrudeRegion(modeState(layered), down(25, 5));
    if (picked?.kind !== 'picked') throw new Error('選べませんでした');
    expect(picked.input.extrudeRegion?.boundary.map(ref => ref.featureId)).toEqual(['side-1', 'side-2', 'side-3', 'side-4']);
  });

  it('3D スケッチ(作図面なし)の要素の輪は、平面に乗っていても領域にしない', () => {
    const free = withFeatures(createEmptyPartDocument(), square('free', 0, 0, 10, 0).map(feature => ({ ...feature, planeId: 'free' })));
    expect(activeExtrudeRegions(modeState(free))?.regions ?? []).toEqual([]);
    expect(extrudeRegionHintKey(modeState(free))).toBeNull();
  });
});

describe('立体の上面にかいた領域では、結果と相手を提案して欄に入れる(M01-4)', () => {
  /** 箱(押し出し1、0〜20)の上面 z=20 に、新しいスケッチで正方形をかいた文書と、その箱の三角形。 */
  function topFaceFixture(): { readonly state: ClickState; readonly document: PartDocument } {
    const base = withFeatures(createEmptyPartDocument(), square('line', 0, 0, 20));
    const extruded = commitSolidInput(base, [], {
      kind: 'solid', tool: 'extrude', step: 'extrudeDistance', values: { distance: num(20) }, flags: { reversed: false, symmetric: false },
      extrudeRegion: { sketchId: activeSketch(base).id, planeId: 'xy', boundary: square('line', 0, 0, 20).map(feature => ({ featureId: feature.id })) },
    });
    if (!extruded.ok) throw new Error(extruded.reasonKey);
    const sketch = createSketchFor(extruded.document);
    const document = withFeatures({ ...addSketch(extruded.document, sketch), activeSketchId: sketch.id }, square('top', 5, 5, 5, 20));
    const positions = new Float32Array([0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0, 0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 20, 20]);
    const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    const body: SuggestionBody = { featureId: document.solids[0].id, volume: 8000, mesh: { positions, indices } };
    return { document, state: modeState(document, { bodies: [body] }) };
  }

  it('外へ押す向き(反転なし)なら結合・相手は箱、と欄に入れる', () => {
    const { state, document } = topFaceFixture();
    const picked = clickExtrudeRegion(state, down(7.5, 7.5));
    if (picked?.kind !== 'picked') throw new Error('選べませんでした');
    const operation = picked.input.choices.find(choice => choice.key === 'extrudeOperation');
    const target = picked.input.choices.find(choice => choice.key === 'extrudeTarget');
    expect(operation?.value).toBe('join');
    expect(target?.value).toBe(document.solids[0].id);
    expect(operation?.suggestion?.reasonKey).toBe('numericInput.extrudeSuggestion.join');
  });

  it('提案に使う向きは、確定した時の押し出しの向き(resolvePart)と同じ', () => {
    const { state, document } = topFaceFixture();
    const picked = clickExtrudeRegion(state, down(7.5, 7.5));
    if (picked?.kind !== 'picked' || picked.input.extrudeRegion === undefined) throw new Error('選べませんでした');
    const committed = commitSolidInput(document, [], {
      kind: 'solid', tool: 'extrude', step: 'extrudeDistance', values: { distance: num(5) }, flags: { reversed: false, symmetric: false },
      extrudeRegion: picked.input.extrudeRegion,
    });
    if (!committed.ok) throw new Error(committed.reasonKey);
    const step = resolvePart(committed.document).steps.at(-1);
    if (step?.plan.kind !== 'extrude') throw new Error('押し出しの段がありません');
    expect(activeExtrudeRegions(state)?.regions[0].region.normal).toEqual(step.plan.direction);
    expect(step.plan.direction).toEqual([0, 0, 1]);
  });
});
