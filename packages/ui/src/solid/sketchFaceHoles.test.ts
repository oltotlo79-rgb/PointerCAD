import { expressionValueFromNumber as num } from '@pointercad/expression';
import { parseDocument, serializeDocument } from '@pointercad/io';
import { absoluteCoordinate, createEmptyPartDocument, replaceSketch, resolveSketch,
  type SketchFaceFeature, type SketchFeature, type Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { commitSketchChamfer, commitSketchFillet } from '../sketch/cornerCommands.js';
import { commitExtend, commitTrim } from '../sketch/editCommands.js';
import { faceBoundaryEntries } from '../sketch/featureSummary.js';
import { pickSketchElement } from '../sketch/pickMath.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { buildRegionFills, sameRegionFillInput, type RegionFillInput } from '../viewport/buildRegionFill.js';
import { buildSketchGeometry, type SketchFaceDraw } from '../viewport/buildSketchGeometry.js';
import { profileCutGeometry } from './cutCommands.js';
import { appendRegionFace, pickExtrudeRegion } from './regionFace.js';
import { commitSolidInput } from './solidCommands.js';

function rectangle(id: string, x: number, y: number, width: number, height: number): SketchFeature {
  return { id, name: id, kind: 'rectangle', planeId: 'xy', construction: false,
    corner1: absoluteCoordinate(x, y, 0), corner2: absoluteCoordinate(x + width, y + height, 0) };
}
function fixture(withFace = true) {
  const base = createEmptyPartDocument();
  const face: SketchFaceFeature = { id: 'face', name: 'face', planeId: 'xy', kind: 'face', color: '#7aa2f7',
    boundary: [{ featureId: 'outer' }], holes: [[{ featureId: 'inner' }]] };
  const sketch = { ...base.sketches[0], features: [rectangle('outer', 0, 0, 60, 40), rectangle('inner', 20, 10, 20, 20),
    ...(withFace ? [face] : [])] };
  return { document: replaceSketch(base, sketch), sketch, face };
}
function area(fill: SketchFaceDraw): number {
  let result = 0;
  for (let at = 0; at < fill.indices.length; at += 3) {
    const [a, b, c] = [0, 1, 2].map(offset => {
      const index = fill.indices[at + offset] * 3;
      return Array.from(fill.positions.slice(index, index + 3));
    });
    const u = b.map((value, index) => value - a[index]), v = c.map((value, index) => value - a[index]);
    result += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return result;
}
function fillInput(): RegionFillInput {
  const polygon: Vec3[] = [[0, 0, 0], [60, 0, 0], [60, 40, 0], [0, 40, 0]];
  const holes: Vec3[][] = [[[20, 10, 0], [40, 10, 0], [40, 30, 0], [20, 30, 0]]];
  return { regions: [{ elementId: 'region', polygon, holes }], color: '#7aa2f7', chosenElementId: null, hoveredElementId: null };
}

describe('穴つきのスケッチ面をUIで扱う(M01-5c)', () => {
  it('領域の穴を保存する面と押し出しと版23を同じ文書変更で返す', () => {
    const { document, sketch } = fixture(false);
    const picked = pickExtrudeRegion(sketch, resolveSketch(sketch), [5, 5, 0]);
    if (!picked.ok) throw new Error(picked.reasonKey);
    expect(picked.region).toMatchObject({ holes: [[{ featureId: 'inner' }]] });
    const outcome = commitSolidInput(document, [], { kind: 'solid', tool: 'extrude', step: 'extrudeDistance',
      values: { distance: num(8) }, flags: {}, extrudeRegion: picked.region });
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    expect(document.schemaVersion).toBe(22);
    expect(outcome.document.schemaVersion).toBe(23);
    expect(outcome.document.solids).toHaveLength(1);
    expect(outcome.document.sketches[0].features.at(-1)).toMatchObject({ kind: 'face', holes: [[{ featureId: 'inner' }]] });
    const read = parseDocument(serializeDocument(outcome.document));
    if (!read.ok) throw new Error(read.error.message);
    expect(read.document).toEqual(outcome.document);
    resetTestStore();
    useAppStore.getState().resetDocument(document);
    useAppStore.getState().applyDocument(outcome.document);
    expect(useAppStore.getState().undoStack.past).toHaveLength(1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toEqual(document);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toEqual(outcome.document);
    resetTestStore();
  });

  it('選択後に消えた穴と、外周に触れる穴は確定しない', () => {
    const { document, sketch } = fixture(false);
    const region = { sketchId: sketch.id, planeId: 'xy', boundary: [{ featureId: 'outer' }], holes: [[{ featureId: 'missing' }]] } as const;
    expect(appendRegionFace(document, region)).toEqual({ ok: false, reasonKey: 'solidError.regionStale' });
    const touching = replaceSketch(document, { ...sketch, features: [sketch.features[0], rectangle('inner', 0, 10, 20, 20)] });
    expect(appendRegionFace(touching, { ...region, holes: [[{ featureId: 'inner' }]] }))
      .toEqual({ ok: false, reasonKey: 'solidError.regionInvalid' });
  });

  it('面の穴内を選ばず、板の部分を選ぶ', () => {
    const { sketch } = fixture();
    const resolved = { ...resolveSketch(sketch), points: [], segments: [], arcs: [], ellipses: [], splines: [] };
    const project = ([x, y]: Vec3): readonly [number, number] => [x, y];
    expect(pickSketchElement(resolved, project, [30, 20])).toBeNull();
    expect(pickSketchElement(resolved, project, [5, 5])?.featureId).toBe('face');
  });

  it('計算待ちの面の縁は外周と穴の両方を囲む', () => {
    const resolved = resolveSketch(fixture().sketch);
    const bundle = buildSketchGeometry({ ...resolved, points: [], segments: [], arcs: [], ellipses: [], splines: [] }, null);
    // 2つの矩形、8辺、線分ごとにxyzが2点。
    expect(bundle.faceOutlines.none).toHaveLength(48);
  });

  it.each([false, true])('穴を埋めずに領域を塗る(傾いた平面 %s)、ホバーだけなら網を使い回す', tilted => {
    const base = fillInput();
    const convert = ([x, y, z]: Vec3): Vec3 => tilted ? [z, x, y] : [x, y, z];
    const regions = base.regions.map(region => ({ ...region, polygon: region.polygon.map(convert), holes: region.holes?.map(hole => hole.map(convert)) }));
    const input = { ...base, regions };
    const [fill] = buildRegionFills(input);
    expect(area(fill)).toBeCloseTo(2000, 9);
    const [hovered] = buildRegionFills({ ...input, hoveredElementId: 'region' });
    expect(hovered.indices).toBe(fill.indices);
    const changed = { ...input, regions: regions.map(region => ({ ...region, holes: [] })) };
    expect(sameRegionFillInput(input, changed)).toBe(false);
    expect(area(buildRegionFills(changed)[0])).toBeCloseTo(2400, 9);
  });

  it.each(['outer', 'inner'])('穴つきの面の境界 %s の丸め・面取りを理由つきで断る', id => {
    const { sketch } = fixture();
    for (const tool of ['sketchFillet', 'sketchChamfer'] as const) {
      const run = tool === 'sketchFillet' ? commitSketchFillet : commitSketchChamfer;
      const result = run(sketch, [`${id}#0`, `${id}#1`], { kind: 'edit', tool,
        step: tool === 'sketchFillet' ? 'sketchFilletRadius' : 'sketchChamferSize',
        values: { cornerRadius: num(2), cornerDistance1: num(2), cornerDistance2: num(2) }, flags: {}, choices: {} });
      expect(result).toEqual({ ok: false, reasonKey: 'solidError.holedFaceCorner' });
    }
  });

  it('穴つきの面の境界のトリム・延長と輪郭切断を理由つきで断る', () => {
    const { document, sketch } = fixture();
    for (const id of ['outer#0', 'inner#0']) {
      expect(commitTrim(sketch, id, [25, 10, 0])).toEqual({ ok: false, reasonKey: 'solidError.holedFaceTrim' });
      expect(commitExtend(sketch, id, [25, 10, 0])).toEqual({ ok: false, reasonKey: 'solidError.holedFaceTrim' });
    }
    expect(profileCutGeometry({ document, bodies: [], selection: [] }, 'body', { sketchId: sketch.id, faceFeatureId: 'face' }))
      .toEqual({ ok: false, reasonKey: 'solidError.holedFaceCut' });
  });

  it('面の境界一覧に穴の参照も含める', () => {
    const { sketch, face } = fixture();
    expect(faceBoundaryEntries(sketch, face).map(entry => entry.elementId)).toEqual(['outer', 'inner']);
  });
});
