import { createKernelApi } from '@pointercad/kernel';
import { expressionValueFromNumber } from '@pointercad/expression';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { createDirectMaterialComparisonBridge } from '../kernelBridge.js';
import type { MaterialComparisonResult } from '../kernelBridge/materialComparisonContracts.js';
import type { SolidBody } from '../kernelBridge/solidContracts.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type { SheetConvertFeature } from '../sheetMetal/types.js';
import { addSketch, appendSolid, createEmptyPartDocument, DEFAULT_PRIMITIVE_AXIS, replaceSolid } from './createPartDocument.js';
import { recomputePart } from './recomputePart.js';
import { resolvePart } from './resolvePart.js';
import { createSheetRecognitionPass } from './sheetRecognitionPass.js';
import type { PartDocument, PrimitiveFeature } from './types.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

type Bridge = ReturnType<typeof createDirectMaterialComparisonBridge>;

function plate(sizeZ: number): PrimitiveFeature {
  return { id: 'plate', name: 'plate', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: DEFAULT_PRIMITIVE_AXIS,
    shape: { kind: 'box', sizeX: expressionValueFromNumber(50), sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(sizeZ) } };
}
function cone(): PrimitiveFeature {
  return { id: 'plate', name: 'plate', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: DEFAULT_PRIMITIVE_AXIS,
    shape: { kind: 'cone', bottomRadius: expressionValueFromNumber(10), topRadius: expressionValueFromNumber(4), height: expressionValueFromNumber(6) } };
}
/** 面積のいちばん大きい平らな面の参照(番号の決め打ちはしない)。 */
function largestPlane(body: SolidBody): SubShapeRef {
  const face = body.faces.filter(entry => entry.surfaceKind === 'plane').reduce((best, entry) => entry.area > best.area ? entry : best);
  return { bodyFeatureId: body.featureId, index: face.index, fingerprint: { kind: 'face', surfaceKind: face.surfaceKind,
    area: face.area, position: face.centroid, axis: face.axis, radius: face.radius } };
}
function convert(face: SubShapeRef): SheetConvertFeature {
  return { kind: 'sheetConvert', id: 'convert-1', name: '板金へ変換', suppressed: false, sourceFeatureId: 'plate', referenceFace: face,
    rule: { innerRadius: expressionValueFromNumber(1), kFactor: expressionValueFromNumber(0.4) } };
}
/** 体積の比べの口を持つ実の計算部の橋(Worker の橋と同じく、変換を元の立体と比べて確かめる)。 */
async function withConvert(source: PrimitiveFeature): Promise<{ readonly document: PartDocument; readonly bridge: Bridge }> {
  const bridge = createDirectMaterialComparisonBridge(createKernelApi(() => Promise.resolve(oc)));
  const before = appendSolid(createEmptyPartDocument(), source);
  const first = await recomputePart(before, bridge);
  expect(first.errors).toEqual([]);
  return { document: appendSolid(before, convert(largestPlane(first.bodies[0]))), bridge };
}

/** 認識と体積の比べを数える橋(中身は実の計算部の橋)。 */
function counted(direct: Bridge): { readonly bridge: Bridge; readonly calls: { recognize: number; readonly compare: MaterialComparisonResult[] } } {
  const calls = { recognize: 0, compare: new Array<MaterialComparisonResult>() };
  const bridge: Bridge = { ...direct,
    recognizeSheetMetal: async (requests) => { calls.recognize += 1; return await direct.recognizeSheetMetal?.(requests) ?? []; },
    compareMaterials: async (before, after, shouldCancel) => {
      const result = await direct.compareMaterials(before, after, shouldCancel); calls.compare.push(result); return result;
    } };
  return { bridge, calls };
}

describe('M-08 立体を板金へ変える行の再計算(実の計算部)', () => {
  it('50×30×2 の箱を板厚 2 の平板 1 枚に変え、元の箱を消費し、元の厚さを変えると板厚が追従する', async () => {
    const { document, bridge } = await withConvert(plate(2));
    const result = await recomputePart(document, bridge);
    expect(result.errors).toEqual([]);
    expect(result.bodies.map(body => body.featureId)).toEqual(['convert-1']);
    expect(result.bodies[0].volume).toBeCloseTo(3000, 6);
    const sheet = result.sheetMetalBodies?.get('convert-1');
    expect(sheet?.converted).toBe(true);
    expect([sheet?.panels.length, sheet?.bends.length, sheet?.rule.thickness.value]).toEqual([1, 0, 2]);
    const thicker = await recomputePart(replaceSolid(document, 'plate', plate(3)), bridge);
    expect(thicker.errors).toEqual([]);
    expect(thicker.bodies[0].volume).toBeCloseTo(4500, 6);
    expect(thicker.sheetMetalBodies?.get('convert-1')?.rule.thickness.value).toBe(3);
  }, 180_000);

  it('変換直後に元の箱と組み直した板金を両方向の差の体積で比べ、持ち回る覚え書きでは同じ形を頼み直さない', async () => {
    const { document, bridge: direct } = await withConvert(plate(2));
    const { bridge, calls } = counted(direct);
    const sheetRecognitions = createSheetRecognitionPass();
    const first = await recomputePart(document, bridge, { sheetRecognitions });
    expect(first.errors).toEqual([]);
    expect([calls.recognize, calls.compare.length]).toEqual([1, 1]);
    const [comparison] = calls.compare;
    if (comparison?.kind !== 'compared') throw new Error('元の箱と組み直した板金を比べられませんでした');
    expect(comparison.result.beforeVolume).toBeCloseTo(3000, 6);
    expect(comparison.result.removed.volume).toBeLessThanOrEqual(3000 * 1e-6);
    expect(comparison.result.added.volume).toBeLessThanOrEqual(3000 * 1e-6);
    const again = await recomputePart(document, bridge, { sheetRecognitions });
    expect(again.errors).toEqual([]);
    expect(again.bodies.map(body => body.featureId)).toEqual(['convert-1']);
    expect([calls.recognize, calls.compare.length]).toEqual([1, 1]);
    sheetRecognitions.clear();
    await recomputePart(document, bridge, { sheetRecognitions });
    expect([calls.recognize, calls.compare.length]).toEqual([2, 2]);
  }, 180_000);

  it('同じ変換IDを持つ形A/Bで、Aの読取り後もBの材料比較にAの元形状を混ぜない', async () => {
    const { document, bridge } = await withConvert(plate(2));
    const thicker = replaceSolid(document, 'plate', plate(3));
    const sheetRecognitions = createSheetRecognitionPass();
    const comparisons: (readonly [readonly string[], readonly string[]])[] = [];
    const observing: Bridge = { ...bridge, compareMaterials: (before, after, shouldCancel) => {
      comparisons.push([before, after]);
      return bridge.compareMaterials(before, after, shouldCancel);
    } };
    const options = { sheetRecognitions };
    const first = await recomputePart(document, observing, options);
    const second = await recomputePart(thicker, observing, options);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);

    const lookup = { sheetRecognition: sheetRecognitions.lookup };
    const shapeA = resolvePart(document, lookup).sheetRecognitionComparisons?.[0];
    const shapeB = resolvePart(thicker, lookup).sheetRecognitionComparisons?.[0];
    if (shapeA === undefined || shapeB === undefined) throw new Error('変換の比較に使った段の鍵がありません');
    expect(shapeA.request.id).toBe(shapeB.request.id);
    expect(shapeA.request.bodyKey).not.toBe(shapeB.request.bodyKey);
    expect(shapeA.rebuiltKey).not.toBe(shapeB.rebuiltKey);
    expect(comparisons).toEqual([
      [[shapeA.request.bodyKey], [shapeA.rebuiltKey]], [[shapeB.request.bodyKey], [shapeB.rebuiltKey]],
    ]);

    const again = await recomputePart(thicker, observing, options);
    expect(again.bodies.map(body => body.featureId)).toEqual(['convert-1']);
    expect(comparisons).toHaveLength(2);
    expect(resolvePart(document, lookup).liveBodyIds).toEqual(['convert-1']);
  }, 180_000);

  it('投影の返事より先に文書が切り替わったら、古い巡は新しい認識の覚え書きを埋めない', async () => {
    const { document, bridge: direct } = await withConvert(plate(2));
    const { bridge, calls } = counted(direct);
    const sheetRecognitions = createSheetRecognitionPass();
    const conversion = document.solids.find((feature): feature is SheetConvertFeature => feature.kind === 'sheetConvert');
    if (conversion === undefined) throw new Error('変換する立体がありません');
    const previous = addSketch(document, { id: 'projection-sketch', name: '投影', features: [
      { id: 'projection', name: '投影1', planeId: DEFAULT_WORK_PLANE_ID, kind: 'projectedCurve',
        source: conversion.referenceFace, construction: false },
    ] });
    let switched = false;
    const old = await recomputePart(previous, { ...bridge, projectSketchCurves: async () => {
      await Promise.resolve();
      sheetRecognitions.clear();
      switched = true;
      return { results: [], failures: [] };
    } }, { sheetRecognitions, shouldCancel: () => switched });
    expect(switched).toBe(true);
    expect(old.cancelled).toBe(true);
    expect([calls.recognize, calls.compare.length]).toEqual([0, 0]);

    const current = await recomputePart(document, bridge, { sheetRecognitions });
    expect(current.errors).toEqual([]);
    expect(current.bodies.map(body => body.featureId)).toEqual(['convert-1']);
    expect([calls.recognize, calls.compare.length]).toEqual([1, 1]);
  }, 180_000);

  it('板厚が一定でない立体は理由の鍵で断り、元の立体を消費しない', async () => {
    const { document, bridge } = await withConvert(cone());
    const result = await recomputePart(document, bridge);
    expect(result.errors.map(error => [error.featureId, error.text.key])).toEqual([['convert-1', 'partError.sheetConvert.variableThickness']]);
    expect(result.bodies.map(body => body.featureId)).toEqual(['plate']);
  }, 180_000);
});
