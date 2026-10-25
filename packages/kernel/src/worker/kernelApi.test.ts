import { describe, expect, it, vi } from 'vitest';
import { expose, releaseProxy, wrap } from 'comlink';

import type {
  PrintabilityCancelToken,
  PrintabilityProgressCallback,
} from '../occt/inspectPrintability.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type { RgbTuple } from '../occt/xcafDocument.js';
import type { FaceColorMap } from '../occt/xcafFaceColors.js';
import type {
  CurveSpec,
  HoleStepSpec,
  PlaneCurve,
  ShapeExportItem,
  ShapeExportAssembly,
  ShapeAssemblyNode,
  ShapeInspectRequest,
  ShapeInspectResult,
  SketchPlaneFrame,
  SolidBodyMesh,
  SolidProgress,
  SolidStepRequest,
  SubShapeQuery,
  Vec3Tuple,
} from '../types.js';
import { createKernelApi, createKernelPhaseObserver, type KernelApi } from './kernelApi.js';
import { recomputeEmptySolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache } from './shapeCache.js';
import { stepBytesForComparison } from './stepBytesForComparison.testSupport.js';

/**
 * `KernelApi.inspectPrintability` を呼ぶ薄い橋渡し。
 *
 * **メソッドを変数へ取り出さず、`target.inspectPrintability(...)` の形で直に呼ぶ**
 * (`const { inspectPrintability } = target` のように切り出すと、`this` の束縛が
 * 外れる形になり `@typescript-eslint/unbound-method` に引っかかる。既存の呼び出しが
 * すべて `api.recomputeSolids(...)` のようにメンバ式のまま呼んでいるのと同じ流儀)。
 *
 * `inspectPrintability` はいま任意の欄(`kernelApi.ts` の注釈。model の
 * `measureBridge.test.ts` の偽物との互換のための経過措置)。`createKernelApi` は
 * 必ず実装するので、無ければテストの前提そのものが崩れている——`!` で握りつぶさず、
 * 理由が分かる例外にして落とす。
 */
async function runInspectPrintability(
  target: KernelApi,
  request: ShapeInspectRequest,
  onProgress?: PrintabilityProgressCallback,
  shouldCancel?: PrintabilityCancelToken,
): Promise<ShapeInspectResult> {
  if (target.inspectPrintability === undefined) {
    throw new Error('createKernelApi は inspectPrintability を必ず実装するはず');
  }
  return target.inspectPrintability(request, onProgress, shouldCancel);
}

/** XY 平面の 10×10 の正方形を、隣り合う頂点をつなぐ 4 本の線分で表す。 */
const SQUARE_CURVES: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
  { kind: 'segment', from: [10, 10, 0], to: [0, 10, 0] },
  { kind: 'segment', from: [0, 10, 0], to: [0, 0, 0] },
];

/** XY 平面の 40×30 の長方形。Z へ 10 押し出すと 40·30·10 = 12000 mm³(手計算)。 */
const RECTANGLE_CURVES: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] },
  { kind: 'segment', from: [40, 0, 0], to: [40, 30, 0] },
  { kind: 'segment', from: [40, 30, 0], to: [0, 30, 0] },
  { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
];
const RECTANGLE_EXTRUDE_VOLUME = 12000;

/** 40×30 の長方形を Z へ distance だけ押し出す 1 段。鍵は検査ごとに変える。 */
function extrudeStep(id: string, key: string, distance: number): SolidStepRequest {
  return {
    key,
    id,
    label: id,
    visible: true,
    step: {
      kind: 'extrude',
      profile: RECTANGLE_CURVES,
      direction: [0, 0, 1],
      distance,
    },
  };
}

/** 掃引体専用の表示粗さが使われる、既定寸法のばね 1 段。 */
function springStep(id: string, key: string): SolidStepRequest {
  return {
    key,
    id,
    label: id,
    visible: true,
    step: {
      kind: 'spring',
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      coilDiameter: 20,
      wireDiameter: 2,
      pitch: 5,
      turns: 4,
      handedness: 'right',
    },
  };
}

/** 線分・円弧の列の長さの合計(mm)。オフセットの結果の確かめに使う。 */
function perimeterOf(curves: readonly CurveSpec[]): number {
  return curves.reduce((sum, curve) => {
    if (curve.kind === 'segment') {
      return (
        sum +
        Math.hypot(
          curve.to[0] - curve.from[0],
          curve.to[1] - curve.from[1],
          curve.to[2] - curve.from[2],
        )
      );
    }
    if (curve.kind === 'arc') {
      return sum + curve.radius * Math.abs(curve.endAngle - curve.startAngle);
    }
    throw new Error(`線分でも円弧でもありません: ${curve.kind}`);
  }, 0);
}

describe('KernelApiの使用中保護', () => {
  it('default worker cache advertises measurement from the first empty state', async () => {
    const target = createKernelApi(loadOcctForNode);
    const partId = 'measured-cache-capability';
    expect(await target.getShapeCacheStats()).toMatchObject({ shapeCount: 0,
      meshBytes: 0, meshBytesMeasured: true });
    try {
      const result = await target.recomputeSolids({ partId, generation: 1,
        steps: [extrudeStep('capability-body', 'capability-key', 10)] });
      expect(result.failures).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const stats = await target.getShapeCacheStats();
      expect(stats.meshBytesMeasured).toBe(true);
      expect(stats.shapeCount).toBeGreaterThan(0);
      expect(stats.meshBytes).toBeGreaterThan(0);
    } finally {
      await target.releasePart(partId);
    }
  });

  const item = (bodyKey: string): ShapeExportItem => ({ bodyKey, name: null, color: null });

  it('forwards refinement limits and keeps its deadline inside the one acquired native request', async () => {
    const target = createKernelApi(loadOcctForNode), partId = 'analysis-refinement-budget';
    try {
      const built = await target.recomputeSolids({ partId, generation: 1,
        steps: [extrudeStep('refinement-box', 'refinement-key', 10)] });
      expect(built.failures).toEqual([]);
      const before = await target.getShapeCacheStats();
      const request = { bodyKey: 'refinement-key', boundary: 'closed' as const,
        linearDeflection: 0.1, angularDeflection: 0.2, materialValidation: 'native-solid' as const,
        freeformRefinement: { maximumChordDeviationMm: 0.01, maximumVolumeDeviationMm3: 0.01,
          maximumNodes: 1, maximumTriangles: 2048 } };
      // A box needs eight nodes. A dropped opt-in would incorrectly return the ordinary successful box mesh.
      expect(await target.buildAnalysisSurfaceMesh(request)).toMatchObject({ kind: 'failed', code: 'limit' });
      let clock = 0;
      const spy = vi.spyOn(performance, 'now').mockImplementation(() => { clock += 25_000; return clock; });
      try {
        await expect(target.buildAnalysisSurfaceMesh({ ...request,
          freeformRefinement: { ...request.freeformRefinement, maximumNodes: 1024 } }))
          .rejects.toMatchObject({ name: 'ExportWorkLimitError' });
      } finally { spy.mockRestore(); }
      expect(await target.getShapeCacheStats()).toEqual(before);
      const ordinary = await target.buildAnalysisSurfaceMesh({ bodyKey: 'refinement-key', boundary: 'closed',
        linearDeflection: 0.1, angularDeflection: 0.2 });
      expect(ordinary.kind).toBe('mesh');
    } finally { await target.releasePart(partId); }
  });

  it('tracked key collision never returns another current feature owner', async () => {
    const target = createKernelApi(loadOcctForNode);
    const box: SolidStepRequest = { id: 'first', key: 'semantic-collision-key', label: 'First',
      visible: true, step: { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
        shape: { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 },
        originQuery: null, targetKey: null } };
    try {
      const first = await target.recomputeSolids({ partId: 'origin-a', generation: 1, steps: [box] });
      expect(first.failures).toEqual([]);
      const denied = await target.readCachedBodies([{ id: 'second', key: box.key }]);
      expect(denied.bodies).toEqual([]);
      expect(denied.failures).toHaveLength(1);
      const second = await target.recomputeSolids({ partId: 'origin-b', generation: 1,
        steps: [{ ...box, id: 'second', label: 'Second' }] });
      expect(second.failures).toEqual([]);
      expect(second.cacheHits).toBe(0);
      const origins = second.bodies[0]?.origins;
      expect(origins?.state).toBe('tracked');
      if (origins?.state === 'tracked') expect(origins.bindings.every((binding) =>
        binding.origin.identity.featureId === 'second')).toBe(true);
    } finally { await target.releasePart('origin-a'); await target.releasePart('origin-b'); }
  });

  it('real Box origin query picks its current face despite a misleading fingerprint and rejects another feature', async () => {
    const target = createKernelApi(loadOcctForNode);
    const box = (id: string, key: string, sizeZ = 20): SolidStepRequest => ({ id, key, label: id, visible: true,
      step: { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
        shape: { kind: 'box', sizeX: 40, sizeY: 30, sizeZ },
        originQuery: null, targetKey: null } });
    const partId = 'semantic-native-query';
    try {
      const built = await target.recomputeSolids({ partId, generation: 1,
        steps: [box('semantic-box-a', 'semantic-box-key-a'), box('semantic-box-b', 'semantic-box-key-b')] });
      expect(built.failures).toEqual([]);
      const first = built.bodies.find(body => body.id === 'semantic-box-a');
      if (first?.origins?.state !== 'tracked') throw new Error('Box origin table is required');
      const faceQuery = (role: 'top' | 'bottom' | 'front'): Extract<SubShapeQuery, { kind: 'face' }> => {
        const binding = first.origins?.state === 'tracked' ? first.origins.bindings.find(item =>
          item.origin.shapeKind === 'face' && item.origin.identity.kind === 'box-face'
          && item.origin.identity.role === role) : undefined;
        if (binding?.state !== 'unique') throw new Error(`Box ${role} origin is not unique`);
        const face = first.faces.find(item => item.index === binding.current.index);
        if (face === undefined) throw new Error(`Box ${role} face is missing`);
        return { kind: 'face', index: face.index, surfaceKind: face.surfaceKind,
          area: face.area, position: face.centroid, axis: face.axis, radius: face.radius,
          origin: binding.origin };
      };
      const top = faceQuery('top'), bottom = faceQuery('bottom'), front = faceQuery('front');
      const misleading = { ...front, origin: top.origin };
      const measured = await target.measure({ kind: 'distance', targets: [
        { bodyKey: 'semantic-box-key-a', subShape: misleading },
        { bodyKey: 'semantic-box-key-a', subShape: bottom },
      ] });
      expect(measured.kind).toBe('distance');
      if (measured.kind === 'distance') expect(measured.distance).toBeCloseTo(20, 6);
      const wrongBody = await target.measure({ kind: 'distance', targets: [
        { bodyKey: 'semantic-box-key-b', subShape: misleading },
        { bodyKey: 'semantic-box-key-a', subShape: bottom },
      ] });
      expect(wrongBody).toMatchObject({ kind: 'failed', message: '選んだ面(辺)が見つかりません。形が大きく変わったため、選び直してください。' });
      const changed = await target.recomputeSolids({ partId, generation: 2, steps: [
        box('semantic-box-b', 'semantic-box-key-b'),
        box('semantic-box-a', 'semantic-box-key-a-taller', 30),
      ] });
      expect(changed.failures).toEqual([]);
      const taller = await target.measure({ kind: 'distance', targets: [
        { bodyKey: 'semantic-box-key-a-taller', subShape: misleading },
        { bodyKey: 'semantic-box-key-a-taller', subShape: bottom },
      ] });
      expect(taller.kind).toBe('distance');
      if (taller.kind === 'distance') expect(taller.distance).toBeCloseTo(30, 6);
    } finally { await target.releasePart(partId); }
  });

  it('export deadline rejection returns no partial files and preserves cached shapes', async () => {
    const target = createKernelApi(loadOcctForNode);
    const partId = 'export-deadline';
    await target.recomputeSolids({ partId, generation: 1,
      steps: [extrudeStep('deadline-body', 'deadline-key', 10)] });
    const before = await target.getShapeCacheStats();
    let clock = 0;
    const clockSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 25_000;
      return clock;
    });
    try {
      await expect(target.exportShapes({ partId, format: 'stl',
        bodies: [item('deadline-key')], deviationMm: 0.1 }))
        .rejects.toMatchObject({ name: 'ExportWorkLimitError' });
    } finally {
      clockSpy.mockRestore();
    }
    expect(await target.getShapeCacheStats()).toEqual(before);
    const after = await target.exportShapes({ partId, format: 'stl',
      bodies: [item('deadline-key')], deviationMm: 0.1 });
    expect(after.format).toBe('stl');
    await target.releasePart(partId);
  });

  it('two real twelve-triangle bodies refuse a smaller internal aggregate quota without partial files', async () => {
    const target = createKernelApi(loadOcctForNode, undefined, 20);
    const partId = 'export-two-body-quota';
    const built = await target.recomputeSolids({ partId, generation: 1,
      steps: [extrudeStep('quota-a', 'quota-a', 10), extrudeStep('quota-b', 'quota-b', 20)] });
    expect(built.failures).toEqual([]);
    expect(built.bodies.map((body) => body.triangleCount)).toEqual([12, 12]);
    const before = await target.getShapeCacheStats();
    let returnedFiles = 0;
    let rejected = false;
    try {
      const result = await target.exportShapes({ partId, format: 'stl',
        bodies: [item('quota-a'), item('quota-b')], deviationMm: 0.1 });
      if (result.format === 'stl') returnedFiles = result.files.length;
    } catch (error) {
      rejected = true;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/上限/);
    }
    expect(rejected).toBe(true);
    expect(returnedFiles).toBe(0);
    expect(await target.getShapeCacheStats()).toEqual(before);
    const one = await target.exportShapes({ partId, format: 'stl',
      bodies: [item('quota-a')], deviationMm: 0.1 });
    expect(one.format).toBe('stl');
    if (one.format === 'stl') {
      expect(one.triangleCount).toBe(12);
      expect(one.files).toHaveLength(1);
    }
    await target.releasePart(partId);
  });

  it('寸法の異なる50部品の最終bodyすべてを測定・STEP書き出しでき、他部品の表示世代も残る', async () => {
    const target = createKernelApi(loadOcctForNode);
    const keys = Array.from({ length: 50 }, (_unused, index) => `part-${index}`);
    let meshBytes = 0;
    try {
      for (const [index, key] of keys.entries()) {
        const result = await target.recomputeSolids({ partId: key, generation: 1, steps: [extrudeStep(key, key, index + 1)] });
        expect(result.failures).toEqual([]);
        const mesh = result.bodies[0];
        meshBytes += mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength + mesh.edgePositions.byteLength;
      }
      expect(await target.getShapeCacheStats()).toMatchObject({ shapeCount: 50, protectedKeyCount: 50, meshBytes, evictions: 0 });
      for (const [index, key] of keys.entries()) {
        const measured = await target.measure({ partId: key, kind: 'massProperties', targets: [{ bodyKey: key, subShape: null }] });
        expect(measured.kind).toBe('massProperties');
        if (measured.kind === 'massProperties') {
          expect(measured.volume).toBeCloseTo(1200 * (index + 1), 6);
        }
      }
      const exported = await target.exportShapes({ format: 'step', bodies: keys.map(item) });
      expect(exported.format).toBe('step');
      const first = await target.inspectPrintability({ partId: keys[0], bodies: [item(keys[0])], deviationMm: 0.1 });
      expect(first.meshes).toEqual([{ bodyKey: keys[0], meshRevision: 1, triangleCount: 12 }]);
      await target.recomputeSolids({ partId: keys[49], generation: 2, steps: [extrudeStep(keys[49], keys[49], 50)] });
      const again = await target.inspectPrintability({ partId: keys[0], bodies: [item(keys[0])], deviationMm: 0.1 });
      expect(again.meshes).toEqual(first.meshes);
      console.log(`50部品: 測定50成功、STEP50形状、meshBytes=${meshBytes}、保護鍵50`);
    } finally {
      for (const key of keys) await target.releasePart(key);
    }
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(0);
  });

  it('別部品が同じ鍵を共有しても片方の置換やreleasePartで残りの保護を外さない', async () => {
    const target = createKernelApi(loadOcctForNode);
    for (const partId of ['a', 'b']) {
      await target.recomputeSolids({ partId, generation: 1, steps: [extrudeStep('body', 'shared', 1)] });
    }
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(1);
    await target.recomputeSolids({ partId: 'a', generation: 2, steps: [extrudeStep('body', 'replacement', 2)] });
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(2);
    await target.releasePart('a');
    await target.releasePart('a');
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(1);
    expect((await target.inspectPrintability({ partId: 'b', bodies: [item('shared')], deviationMm: 0.1 })).meshes[0].meshRevision).toBe(1);
    await expect(target.inspectPrintability({ partId: 'a', bodies: [item('replacement')], deviationMm: 0.1 })).rejects.toThrow(/もとになる立体/);
    await target.releasePart('b');
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(0);
  });

  it('取消jobの確保鍵数が0→2→0に戻る', async () => {
    const target = createKernelApi(loadOcctForNode);
    const counts = [(await target.getShapeCacheStats()).protectedKeyCount];
    const result = await target.recomputeSolids({ generation: 1, steps: [extrudeStep('a', 'a', 1), extrudeStep('b', 'b', 2)] }, {}, undefined, async () => {
      counts.push((await target.getShapeCacheStats()).protectedKeyCount);
      return true;
    });
    expect(result.cancelled).toBe(true);
    counts.push((await target.getShapeCacheStats()).protectedKeyCount);
    expect(counts).toEqual([0, 2, 0]);
  });

  it('全段失敗したjobの入力保護は残らない', async () => {
    const target = createKernelApi(loadOcctForNode);
    const result = await target.recomputeSolids({ generation: 1, steps: [extrudeStep('bad', 'bad', 0)] });
    expect(result.failures).toHaveLength(1);
    expect(await target.getShapeCacheStats()).toMatchObject({ protectedKeyCount: 0, shapeCount: 0 });
  });

  it('進捗・取消callbackの例外でもjobの確保を外す', async () => {
    const target = createKernelApi(loadOcctForNode);
    const request = { generation: 1, steps: [extrudeStep('a', 'a', 1), extrudeStep('b', 'b', 2)] };
    await expect(target.recomputeSolids(request, {}, () => { throw new Error('進捗失敗'); })).rejects.toThrow('進捗失敗');
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(0);
    await expect(target.recomputeSolids(request, {}, undefined, () => { throw new Error('取消確認失敗'); })).rejects.toThrow('取消確認失敗');
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(0);
  });

  it('再計算と複数形操作はOCCT読み込み前から確保し、読み込み例外でも0に戻す', async () => {
    const counts: number[] = [];
    const target = createKernelApi(async () => {
      counts.push((await target.getShapeCacheStats()).protectedKeyCount);
      throw new Error('読み込み失敗');
    });
    const plane: SketchPlaneFrame = { origin: [0, 0, 0], axisU: [1, 0, 0], normal: [0, 0, 1] };
    const operations = [
      () => target.recomputeSolids({ generation: 1, steps: [extrudeStep('a', 'a', 1), extrudeStep('b', 'b', 2)] }),
      () => target.exportShapes({ format: 'step', bodies: [item('a'), item('b')] }),
      () => target.measure({ kind: 'distance', targets: [{ bodyKey: 'a', subShape: null }, { bodyKey: 'b', subShape: null }] }),
      () => target.projectSketchCurves({ items: ['a', 'b'].map((key) => ({ id: key, shapeKey: key, subShape: null, plane })) }),
      () => target.sectionSketchCurves({ items: ['a', 'b'].map((key) => ({ id: key, shapeKey: key, plane })) }),
    ];
    for (const operation of operations) {
      counts.push((await target.getShapeCacheStats()).protectedKeyCount);
      await expect(operation()).rejects.toThrow('読み込み失敗');
      counts.push((await target.getShapeCacheStats()).protectedKeyCount);
    }
    expect(counts).toEqual([0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0]);
  });

  it('成功する書き出し・測定の前後も確保鍵数が0→2→0に戻る', async () => {
    let record = false;
    const counts: number[] = [];
    const target = createKernelApi(async () => {
      if (record) counts.push((await target.getShapeCacheStats()).protectedKeyCount);
      return loadOcctForNode();
    });
    await target.recomputeSolids({ generation: 1, steps: [extrudeStep('a', 'a', 1), extrudeStep('b', 'b', 2)] });
    await target.releasePart('part:current');
    record = true;
    counts.push((await target.getShapeCacheStats()).protectedKeyCount);
    expect((await target.exportShapes({ format: 'brep', bodies: [item('a'), item('b')] })).format).toBe('brep');
    counts.push((await target.getShapeCacheStats()).protectedKeyCount);
    expect((await target.measure({ kind: 'distance', targets: [{ bodyKey: 'a', subShape: null }, { bodyKey: 'b', subShape: null }] })).kind).toBe('distance');
    counts.push((await target.getShapeCacheStats()).protectedKeyCount);
    expect(counts).toEqual([0, 2, 0, 2, 0]);
  });

  it('点検中に部品を解放しても操作の保護は残り、取消完了時に0へ戻る', async () => {
    const target = createKernelApi(loadOcctForNode);
    await target.recomputeSolids({ partId: 'inspect', generation: 1, steps: [extrudeStep('a', 'a', 1), extrudeStep('b', 'b', 2)] });
    const counts: number[] = [];
    const result = await target.inspectPrintability({ partId: 'inspect', bodies: [item('a'), item('b')], deviationMm: 0.1 }, undefined, async () => {
      await target.releasePart('inspect');
      counts.push((await target.getShapeCacheStats()).protectedKeyCount);
      return true;
    });
    expect(result.cancelled).toBe(true);
    counts.push((await target.getShapeCacheStats()).protectedKeyCount);
    expect(counts).toEqual([2, 0]);
  });

  it('履歴外の入力鍵もjob開始時に確保する', async () => {
    let record = false;
    const counts: number[] = [];
    const target = createKernelApi(async () => {
      if (record) counts.push((await target.getShapeCacheStats()).protectedKeyCount);
      return loadOcctForNode();
    });
    await target.recomputeSolids({ generation: 1, steps: [extrudeStep('input', 'input', 1)] });
    await target.releasePart('part:current');
    record = true;
    const result = await target.recomputeSolids({ generation: 2, steps: [{ id: 'scaled', key: 'scaled', label: 'scaled', visible: true, step: { kind: 'scale', targetKey: 'input', origin: [0, 0, 0], uniform: 2, perAxis: null } }] });
    expect(result.failures).toEqual([]);
    expect(counts).toEqual([2]);
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(1);
    await target.releasePart('part:current');
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(0);
  });

  it('進行中jobの部品をreleasePartすると、完了しても保護や表示を復活させない', async () => {
    const target = createKernelApi(loadOcctForNode);
    const result = await target.recomputeSolids({ partId: 'removed', generation: 1, steps: [extrudeStep('a', 'a', 1), extrudeStep('b', 'b', 2)] }, {}, undefined, async () => {
      await target.releasePart('removed');
      return false;
    });
    expect(result.failures).toEqual([]);
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(0);
    await expect(target.inspectPrintability({ partId: 'removed', bodies: [item('a')], deviationMm: 0.1 })).rejects.toThrow(/もとになる立体/);
  });

  it('同じ部品の新jobが先に完了した場合、後から終わる旧jobで最終形や表示を戻さない', async () => {
    const target = createKernelApi(loadOcctForNode);
    let oldStarted = false;
    let newerRuns = 0;
    await target.recomputeSolids({ partId: 'part', generation: 1, steps: [extrudeStep('old-a', 'old-a', 1), extrudeStep('old-b', 'old-b', 2)] }, {}, () => { oldStarted = true; }, async () => {
      // 取消照会の回数に依存せず、旧jobの開始後に新jobを1度だけ完了させる。
      if (oldStarted && newerRuns === 0) {
        newerRuns++;
        await target.recomputeSolids({ partId: 'part', generation: 2, steps: [extrudeStep('new', 'new', 3)] });
      }
      return false;
    });
    expect(newerRuns).toBe(1);
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(1);
    expect((await target.inspectPrintability({ partId: 'part', bodies: [item('new')], deviationMm: 0.1 })).meshes[0].meshRevision).toBe(1);
    await expect(target.inspectPrintability({ partId: 'part', bodies: [item('old-a')], deviationMm: 0.1 })).rejects.toThrow(/もとになる立体/);
    await target.releasePart('part');
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(0);
  });

  it('Comlink越しにも欠落の種類と構造化したpartId・missingKeysが届く', async () => {
    const target = createKernelApi(loadOcctForNode);
    const channel = new MessageChannel();
    expose(target, channel.port1);
    const remote = wrap<ReturnType<typeof createKernelApi>>(channel.port2);
    try {
      await expect(remote.exportShapes({ partId: 'lost', format: 'step', bodies: [item('missing')] })).rejects.toMatchObject({ name: 'MissingBodiesError', message: 'もとになる立体が見つかりませんでした。もう一度計算し直してください。' });
      expect(await remote.checkShapeAvailability('lost', ['missing', 'missing', 'other'])).toEqual({ partId: 'lost', missingKeys: ['missing', 'other'] });
      expect((await remote.getShapeCacheStats()).protectedKeyCount).toBe(0);
      await remote.releasePart('lost');
    } finally {
      remote[releaseProxy]();
      channel.port1.close();
      channel.port2.close();
    }
  });
});

describe('KernelApiの表示メッシュ保持量(実体の会計と要求の確保を外した後の最終会計)', () => {
  const LOCAL = { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 };
  const boxStep = (id: string, key: string, size = 20, origin: Vec3Tuple = [0, 0, 0],
    visible = true): SolidStepRequest => ({ id, key, label: id, visible,
    step: { kind: 'primitive', origin, axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size }, originQuery: null, targetKey: null } });
  const buffersOf = (bodies: readonly SolidBodyMesh[]): ReadonlySet<ArrayBufferLike> => new Set(bodies.flatMap(
    (body) => [body.positions.buffer, body.normals.buffer, body.indices.buffer, body.edgePositions.buffer]));
  const bytesOf = (buffers: Iterable<ArrayBufferLike>): number => {
    let bytes = 0;
    for (const buffer of new Set(buffers)) bytes += buffer.byteLength;
    return bytes;
  };
  const viewBytes = (bodies: readonly SolidBodyMesh[]): number => bodies.reduce((sum, body) => sum
    + body.positions.byteLength + body.normals.byteLength + body.indices.byteLength
    + body.edgePositions.byteLength, 0);

  it('refuses nonempty geometry at the empty-only entry before reading cache accounting', () => {
    const cache = createShapeCache<CachedSolid>();
    const stats = vi.spyOn(cache, 'stats');
    expect(() => recomputeEmptySolids({ cache }, { generation: 1, steps: [boxStep('real', 'real')],
      localMesh: LOCAL })).toThrow('Empty recompute requires no solid steps');
    expect(stats).not.toHaveBeenCalled();
    cache.clear();
  });

  it('certifies the first empty local request without loading OCCT or inventing WASM memory', async () => {
    const load = vi.fn(() => Promise.reject(new Error('Empty work must not load OCCT')));
    const target = createKernelApi(load);
    try {
      const empty = await target.recomputeSolids({ partId: 'cold-empty', generation: 1,
        steps: [], localMesh: LOCAL });
      expect(load).not.toHaveBeenCalled();
      expect(empty).toMatchObject({ bodies: [], failures: [], cacheHits: 0, cancelled: false, appearanceMatches: [] });
      expect(empty.memory).toBeUndefined();
      expect(await target.getShapeCacheStats()).toMatchObject({ shapeCount: 0,
        meshByteCounts: { status: 'known', activeBytes: 0, retiredBytes: 0, protectedBytes: 0, totalBytes: 0 } });
      expect(empty.meshJsAccounting).toEqual({ status: 'known', limitBytes: LOCAL.maximumLiveMeshBytes,
        cacheActiveBytes: 0, cacheRetiredBytes: 0, cacheProtectedBytes: 0,
        retainedReplyBytes: 0, requestPeakReservedBytes: 0 });
      expect(empty.meshJsFinalAccounting).toEqual({ status: 'known', limitBytes: LOCAL.maximumLiveMeshBytes,
        cacheActiveBytes: 0, cacheRetiredBytes: 0, cacheProtectedBytes: 0,
        displayBackingBytes: 0, replyBackingBytes: 0, retainedBackingBytes: 0, replyCloneReservedBytes: 0 });
      const world = await target.recomputeSolids({ partId: 'cold-empty', generation: 2, steps: [] });
      expect(world.meshJsAccounting).toBeUndefined();
      expect(world.meshJsFinalAccounting).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
    } finally { await target.releasePart('cold-empty'); }
  });

  it('clears an old local display without another load while preserving other parts and real cache bytes', async () => {
    const load = vi.fn(loadOcctForNode), target = createKernelApi(load);
    try {
      const first = await target.recomputeSolids({ partId: 'empty-after-solid', generation: 1,
        localMesh: LOCAL, steps: [boxStep('old-local', 'old-local', 20, [1e9, 0, 0])] });
      const other = await target.recomputeSolids({ partId: 'kept-other-part', generation: 1,
        localMesh: LOCAL, steps: [boxStep('other-local', 'other-local', 30)] });
      expect(first.failures).toEqual([]); expect(other.failures).toEqual([]);
      expect(first.bodies[0].volume).toBeCloseTo(8000, 6);
      expect(other.bodies[0].volume).toBeCloseTo(27000, 6);
      expect(load).toHaveBeenCalledTimes(2);
      const before = await target.getShapeCacheStats();
      expect(before.protectedKeyCount).toBe(2);
      const empty = await target.recomputeSolids({ partId: 'empty-after-solid', generation: 2,
        localMesh: LOCAL, steps: [] });
      expect(load).toHaveBeenCalledTimes(2);
      expect(empty.bodies).toEqual([]); expect(empty.failures).toEqual([]);
      expect(empty.cancelled).toBe(false);
      expect(other.memory?.wasmHeapBytes).toBeGreaterThan(0);
      expect(empty.memory).toEqual(other.memory);
      const after = await target.getShapeCacheStats();
      if (before.meshByteCounts.status !== 'known' || after.meshByteCounts.status !== 'known') {
        throw new Error('Default cache must provide actual byte counts');
      }
      expect(after.protectedKeyCount).toBe(1);
      expect(after.meshByteCounts.activeBytes).toBeGreaterThan(0);
      expect(after.meshByteCounts.protectedBytes).toBeLessThan(before.meshByteCounts.protectedBytes);
      expect(empty.meshJsAccounting).toMatchObject({ status: 'known',
        cacheProtectedBytes: before.meshByteCounts.protectedBytes, retainedReplyBytes: 0 });
      const otherDisplay = bytesOf(buffersOf(other.bodies));
      expect(empty.meshJsFinalAccounting).toEqual({ status: 'known', limitBytes: LOCAL.maximumLiveMeshBytes,
        cacheActiveBytes: after.meshByteCounts.activeBytes, cacheRetiredBytes: after.meshByteCounts.retiredBytes,
        cacheProtectedBytes: after.meshByteCounts.protectedBytes, displayBackingBytes: otherDisplay,
        replyBackingBytes: 0, retainedBackingBytes: after.meshByteCounts.totalBytes + otherDisplay,
        replyCloneReservedBytes: 0 });
      const rebuilt = await target.recomputeSolids({ partId: 'empty-after-solid', generation: 3,
        localMesh: LOCAL, steps: [boxStep('new-local', 'new-local', 10)] });
      expect(load).toHaveBeenCalledTimes(3);
      expect(rebuilt.failures).toEqual([]); expect(rebuilt.bodies[0].volume).toBeCloseTo(1000, 6);
    } finally {
      await target.releasePart('empty-after-solid'); await target.releasePart('kept-other-part');
    }
  });

  it.each([0, -1, Number.NaN, 512 * 1024 * 1024 + 1])('rejects empty invalid budget %s before OCCT load', async maximumLiveMeshBytes => {
    const load = vi.fn(() => Promise.reject(new Error('Invalid empty work must not load OCCT')));
    const target = createKernelApi(load);
    try {
      await expect(target.recomputeSolids({ partId: 'bad-empty-budget', generation: 1,
        steps: [], localMesh: { ...LOCAL, maximumLiveMeshBytes } })).rejects.toThrow(
        'Local mesh requires finite positive display and memory budgets');
      expect(load).not.toHaveBeenCalled();
    } finally { await target.releasePart('bad-empty-budget'); }
  });

  it('keeps missing backing identities unknown even for an empty request without OCCT', async () => {
    const cache = createShapeCache<CachedSolid>(undefined, ({ mesh }) => mesh.positions.byteLength
      + mesh.normals.byteLength + mesh.indices.byteLength + mesh.edgePositions.byteLength);
    const load = vi.fn(() => Promise.reject(new Error('Empty work must not load OCCT')));
    const target = createKernelApi(load, cache);
    try {
      const empty = await target.recomputeSolids({ partId: 'unknown-empty', generation: 1,
        steps: [], localMesh: LOCAL });
      expect(empty.meshJsAccounting).toEqual({ status: 'unknown', limitBytes: LOCAL.maximumLiveMeshBytes,
        reason: 'callback-missing' });
      expect(empty.meshJsFinalAccounting).toEqual({ status: 'unknown', limitBytes: LOCAL.maximumLiveMeshBytes,
        reason: 'callback-missing' });
      expect(load).not.toHaveBeenCalled();
    } finally { await target.releasePart('unknown-empty'); cache.clear(); }
  });

  it('keeps real empty ownership, preclone admission refusal and receiver acknowledgement without OCCT', async () => {
    const load = vi.fn(() => Promise.reject(new Error('Empty work must not load OCCT')));
    const target = createKernelApi(load);
    const owner = { dispatchId: 'managed-empty', partId: 'managed-empty-part', generation: 1,
      kind: 'display' as const, steps: [] };
    const request = { partId: owner.partId, generation: owner.generation, steps: [], localMesh: LOCAL };
    try {
      await expect(target.recomputeSolids({ ...request, generation: 2 }, {}, undefined, undefined, owner, () => true))
        .rejects.toThrow('Dispatch mesh owner mismatch');
      await expect(target.recomputeSolids(request, {}, undefined, undefined, owner, () => false))
        .rejects.toThrow('Global pre-clone mesh reply admission refused');
      expect(await target.acknowledgeMeshReply?.(owner)).toEqual({ acknowledged: false, absent: true });
      const admitted = vi.fn(() => true);
      const empty = await target.recomputeSolids(request, {}, undefined, undefined, owner, admitted);
      expect(admitted).toHaveBeenCalledExactlyOnceWith({ owner, replyBackingBytes: 0, workerRetainedBackingBytes: 0 });
      expect(empty.meshJsFinalAccounting?.status).toBe('known');
      expect(await target.readPartOwnership?.(owner)).toMatchObject({ status: 'current', owner });
      expect(await target.acknowledgeMeshReply?.(owner)).toEqual({ acknowledged: true });
      expect(load).not.toHaveBeenCalled();
    } finally { await target.acknowledgeMeshReply?.(owner); await target.releasePart(owner.partId); }
  });

  it('the default worker cache counts each body buffer once and keeps the legacy view scalar', async () => {
    const target = createKernelApi(loadOcctForNode);
    const partId = 'backing-producer';
    try {
      const built = await target.recomputeSolids({ partId, generation: 1,
        steps: [boxStep('backing-a', 'backing-a'), boxStep('backing-b', 'backing-b', 30)] });
      expect(built.failures).toEqual([]);
      const whole = bytesOf(buffersOf(built.bodies));
      expect(whole).toBeGreaterThan(0);
      expect(await target.getShapeCacheStats()).toMatchObject({ meshBytes: viewBytes(built.bodies),
        meshBytesMeasured: true, meshBackingBytesMeasured: true, meshByteCounts: { status: 'known',
          activeBytes: whole, retiredBytes: 0, protectedBytes: whole, totalBytes: whole } });
      expect('meshJsFinalAccounting' in built).toBe(false);
    } finally {
      await target.releasePart(partId);
    }
    expect((await target.getShapeCacheStats()).meshByteCounts).toMatchObject({ protectedBytes: 0 });
  });

  it('final accounting is sampled after the request token, so a request-only retired body is gone', async () => {
    const target = createKernelApi(loadOcctForNode);
    const partId = 'post-token';
    try {
      const first = await target.recomputeSolids({ partId, generation: 1,
        steps: [boxStep('original', 'shared-box')] });
      expect(first.failures).toEqual([]);
      const originalBytes = bytesOf(buffersOf(first.bodies));
      // A different tracked owner rebuilds the same key while the old display and this request
      // protect it. Only the request protects it after the display moves to the scaled body.
      const second = await target.recomputeSolids({ partId, generation: 2, localMesh: LOCAL, steps: [
        boxStep('replacement', 'shared-box', 20, [0, 0, 0], false),
        { id: 'scaled', key: 'scaled-box', label: 'scaled', visible: true,
          step: { kind: 'scale', targetKey: 'shared-box', origin: [0, 0, 0], uniform: 2, perAxis: null } },
      ] });
      expect(second.failures).toEqual([]);
      expect(second.meshJsAccounting).toMatchObject({ status: 'known', cacheRetiredBytes: originalBytes });
      const after = await target.getShapeCacheStats();
      if (after.meshByteCounts.status !== 'known') throw new Error('default cache must be measured');
      const reply = bytesOf(buffersOf(second.bodies));
      expect(second.meshJsFinalAccounting).toEqual({ status: 'known', limitBytes: LOCAL.maximumLiveMeshBytes,
        cacheActiveBytes: after.meshByteCounts.activeBytes, cacheRetiredBytes: 0,
        cacheProtectedBytes: after.meshByteCounts.protectedBytes, displayBackingBytes: reply,
        replyBackingBytes: reply, retainedBackingBytes: after.meshByteCounts.activeBytes + reply,
        replyCloneReservedBytes: reply });
      expect(after.meshByteCounts.protectedBytes).toBeLessThan(after.meshByteCounts.activeBytes);
      expect(after.protectedKeyCount).toBe(1);
    } finally {
      await target.releasePart(partId);
    }
  });

  it("another part's local display counts in the live budget and in the final union", async () => {
    const target = createKernelApi(loadOcctForNode);
    try {
      const a = await target.recomputeSolids({ partId: 'display-a', generation: 1, localMesh: LOCAL,
        steps: [boxStep('far-a', 'far-a', 20, [1e9, 0, 0])] });
      expect(a.failures).toEqual([]);
      const aLocal = bytesOf(buffersOf(a.bodies));
      expect(a.meshJsFinalAccounting).toMatchObject({ status: 'known', displayBackingBytes: aLocal,
        replyBackingBytes: aLocal, replyCloneReservedBytes: aLocal });
      const bWorld = await target.recomputeSolids({ partId: 'display-b', generation: 1,
        steps: [boxStep('near-b', 'near-b')] });
      expect(bWorld.failures).toEqual([]);
      const cached = await target.getShapeCacheStats();
      if (cached.meshByteCounts.status !== 'known') throw new Error('default cache must be measured');
      const mesh = bWorld.bodies[0];
      const origins = mesh.origins;
      const originRows = origins === undefined ? 0 : origins.state === 'tracked'
        ? origins.bindings.length + (origins.fingerprintFallback?.length ?? 0) : 1;
      const originUtf8Bytes = origins === undefined ? 0 : new TextEncoder().encode(JSON.stringify(origins)).byteLength;
      expect(origins).toBeDefined();
      expect(originRows).toBeGreaterThan(0);
      expect(originUtf8Bytes).toBeGreaterThan(0);
      const metadata = 4096 + 512 * (mesh.faces.length + mesh.edges.length + mesh.vertices.length
        + mesh.threadMarks.length + originRows) + 2 * originUtf8Bytes;
      const exact = cached.meshByteCounts.totalBytes + aLocal + 2 * viewBytes([mesh])
        + 4 * mesh.edgePositions.byteLength + 2 * mesh.positions.byteLength + 2 * metadata;
      // A cache-only budget, which omitted part A's live display arrays, would admit exact - 1.
      expect(exact - 1).toBeGreaterThanOrEqual(exact - aLocal);
      expect(aLocal).toBeGreaterThan(0);
      const refused = await target.recomputeSolids({ partId: 'display-b', generation: 2,
        steps: [boxStep('near-b', 'near-b')], localMesh: { ...LOCAL, maximumLiveMeshBytes: exact - 1 } });
      expect(refused.bodies).toEqual([]);
      expect(refused.failures).toHaveLength(1);
      const admitted = await target.recomputeSolids({ partId: 'display-b', generation: 3,
        steps: [boxStep('near-b', 'near-b')], localMesh: { ...LOCAL, maximumLiveMeshBytes: exact } });
      expect(admitted.failures).toEqual([]);
      expect(admitted.cacheHits).toBe(1);
      expect(admitted.meshJsAccounting).toMatchObject({ status: 'known',
        cacheActiveBytes: cached.meshByteCounts.totalBytes, requestPeakReservedBytes: exact });
      const bLocal = bytesOf(buffersOf(admitted.bodies));
      const after = await target.getShapeCacheStats();
      if (after.meshByteCounts.status !== 'known') throw new Error('default cache must be measured');
      expect(admitted.meshJsFinalAccounting).toEqual({ status: 'known', limitBytes: exact,
        cacheActiveBytes: cached.meshByteCounts.totalBytes, cacheRetiredBytes: 0,
        cacheProtectedBytes: after.meshByteCounts.protectedBytes, displayBackingBytes: aLocal + bLocal,
        replyBackingBytes: bLocal, retainedBackingBytes: cached.meshByteCounts.totalBytes + aLocal + bLocal,
        replyCloneReservedBytes: bLocal });
    } finally {
      await target.releasePart('display-a');
      await target.releasePart('display-b');
    }
  });

  it('a cancelled local job keeps the old display and counts its partial reply after the request token', async () => {
    const target = createKernelApi(loadOcctForNode);
    const partId = 'cancel-final';
    try {
      const first = await target.recomputeSolids({ partId, generation: 1, localMesh: LOCAL,
        steps: [boxStep('kept', 'kept', 20, [0, 1e9, 0])] });
      expect(first.failures).toEqual([]);
      const kept = bytesOf(buffersOf(first.bodies));
      let checks = 0;
      const cancelled = await target.recomputeSolids({ partId, generation: 2, localMesh: LOCAL,
        steps: [boxStep('partial', 'partial', 30), boxStep('never', 'never', 40)] }, {}, undefined,
      () => { checks += 1; return checks === 2; });
      expect(cancelled.cancelled).toBe(true);
      expect(cancelled.bodies.map((body) => body.id)).toEqual(['partial']);
      const partial = bytesOf(buffersOf(cancelled.bodies));
      const after = await target.getShapeCacheStats();
      if (after.meshByteCounts.status !== 'known') throw new Error('default cache must be measured');
      expect(after.protectedKeyCount).toBe(1);
      expect(cancelled.meshJsFinalAccounting).toEqual({ status: 'known', limitBytes: LOCAL.maximumLiveMeshBytes,
        cacheActiveBytes: after.meshByteCounts.activeBytes, cacheRetiredBytes: 0,
        cacheProtectedBytes: after.meshByteCounts.protectedBytes, displayBackingBytes: kept,
        replyBackingBytes: partial, retainedBackingBytes: after.meshByteCounts.activeBytes + kept + partial,
        replyCloneReservedBytes: partial });
      expect((await target.inspectPrintability({ partId, bodies: [{ bodyKey: 'kept', name: null, color: null }],
        deviationMm: 0.1 })).meshes[0].meshRevision).toBe(1);
    } finally {
      await target.releasePart(partId);
    }
  });

  it('an injected cache without buffer identities fails closed and never reports zero', async () => {
    const numeric = createShapeCache<CachedSolid>(undefined, ({ mesh }) => mesh.positions.byteLength
      + mesh.normals.byteLength + mesh.indices.byteLength + mesh.edgePositions.byteLength);
    const target = createKernelApi(loadOcctForNode, numeric);
    try {
      const result = await target.recomputeSolids({ partId: 'numeric-only', generation: 1, localMesh: LOCAL,
        steps: [boxStep('numeric', 'numeric')] });
      expect(result.bodies).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.meshJsAccounting).toEqual({ status: 'unknown', limitBytes: LOCAL.maximumLiveMeshBytes,
        reason: 'callback-missing' });
      expect(result.meshJsFinalAccounting).toEqual({ status: 'unknown',
        limitBytes: LOCAL.maximumLiveMeshBytes, reason: 'callback-missing' });
      const world = await target.recomputeSolids({ partId: 'numeric-only', generation: 2,
        steps: [boxStep('numeric', 'numeric')] });
      expect(world.failures).toEqual([]);
      expect('meshJsFinalAccounting' in world).toBe(false);
    } finally {
      await target.releasePart('numeric-only');
      numeric.clear();
    }
  });
});

describe('KernelApi', () => {
  const api = createKernelApi(loadOcctForNode);

  it('別部品の履歴が容量256を超えても、先の部品の最終bodyを測定・書き出しできる', async () => {
    const target = createKernelApi(loadOcctForNode);
    const first = { partId: 'part:first', generation: 1, steps: [extrudeStep('first', 'first-final', 1)] };
    const second = {
      partId: 'part:second',
      generation: 1,
      steps: Array.from({ length: 257 }, (_unused, index) => ({
        ...extrudeStep(`second-${index}`, `second-${index}`, index + 2),
        visible: index === 256,
      })),
    };
    expect((await target.recomputeSolids(first)).failures).toEqual([]);
    expect((await target.recomputeSolids(second)).failures).toEqual([]);
    const measured = await target.measure({ kind: 'massProperties', targets: [{ bodyKey: 'first-final', subShape: null }] });
    console.log(`追い出し再現: 登録鍵258、容量256、先の最終鍵first-final、測定結果=${measured.kind}`);
    await expect(target.exportShapes({ format: 'step', bodies: [{ bodyKey: 'first-final', name: null, color: null }] })).resolves.toMatchObject({ format: 'step' });
    expect(measured.kind).toBe('massProperties');
    expect(await target.checkShapeAvailability('part:second', ['first-final', 'second-0', 'second-1', 'second-2'])).toEqual({ partId: 'part:second', missingKeys: ['second-0', 'second-1'] });
    expect(await target.getShapeCacheStats()).toMatchObject({ size: 256, evictions: 2, protectedKeyCount: 2, protectedOverBudget: 0 });
    await target.releasePart('part:first');
    await target.releasePart('part:second');
    expect((await target.getShapeCacheStats()).protectedKeyCount).toBe(0);
  });

  it('履歴の段から立体のメッシュを作り、進捗を段ごとに知らせる', async () => {
    const progress: SolidProgress[] = [];
    const result = await api.recomputeSolids(
      { steps: [extrudeStep('extrude-1', 'api-extrude', 10)], generation: 1 },
      {},
      (value) => {
        progress.push(value);
      },
    );

    expect(result.failures).toEqual([]);
    expect(result.cancelled).toBe(false);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('extrude-1');
    expect(result.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
    expect(result.bodies[0].faceCount).toBe(6);
    expect(result.bodies[0].edgeCount).toBe(12);
    expect(progress).toEqual([
      { stepId: 'extrude-1', index: 0, total: 1, label: 'extrude-1' },
    ]);
  });

  it('同じ鍵の依頼を続けて呼ぶと、窓口が持つキャッシュが効く(NFR-PF-3)', async () => {
    const request = {
      steps: [extrudeStep('extrude-1', 'api-cache', 10)],
      generation: 1,
    };

    const first = await api.recomputeSolids(request);
    expect(first.cacheHits).toBe(0);

    const second = await api.recomputeSolids(request);
    expect(second.cacheHits).toBe(1);
    expect(second.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
  });

  it('hidden local admission refusal plus cleanup throw preserves the actual lease for retry', async () => {
    const cache = createShapeCache<CachedSolid>(undefined,
      ({ mesh }) => mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength + mesh.edgePositions.byteLength,
      ({ mesh }) => [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.edgePositions.buffer]);
    const target = createKernelApi(loadOcctForNode, cache), step = extrudeStep('cleanup-source', 'cleanup-source-key', 10);
    const limitBytes = 64 * 1024 * 1024;
    const owner = { dispatchId: 'hidden-cleanup-local', partId: 'hidden-cleanup-part', generation: 1,
      kind: 'hidden' as const, steps: [{ id: step.id, key: step.key }] };
    let restoreRelease: (() => void) | undefined;
    try {
      expect((await target.recomputeSolids({ partId: owner.partId, generation: 1, steps: [step] })).failures).toEqual([]);
      const cached = cache.get(step.key);
      const releaseFailure = vi.spyOn(cache, 'release').mockImplementationOnce(() => { throw new Error('external release failure'); });
      restoreRelease = () => { releaseFailure.mockRestore(); };
      await expect(target.readCachedBodies(owner.steps, { owner, limitBytes,
        localMesh: { maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: limitBytes } }, () => false))
        .rejects.toThrow('Reference mesh lease cleanup failed');
      expect(cache.get(step.key)).toBe(cached);
      expect(cache.stats().protectedKeyCount).toBe(1);
      restoreRelease(); restoreRelease = undefined;
      expect(await target.releaseReferenceMeshLease?.(owner)).toEqual({ released: true });
      expect(await target.releaseReferenceMeshLease?.(owner)).toEqual({ released: false, absent: true });
      expect(cache.get(step.key)).toBe(cached);
    } finally { restoreRelease?.(); await target.releaseReferenceMeshLease?.(owner); await target.releasePart(owner.partId); cache.clear(); }
  });

  it('hidden local reply has actual native geometry, retained owner, receiver ACK and legacy world compatibility', async () => {
    const target = createKernelApi(loadOcctForNode), step = extrudeStep('hidden-source', 'hidden-source-key', 10);
    const limitBytes = 64 * 1024 * 1024;
    const owner = { dispatchId: 'hidden-local-lease', partId: 'hidden-local-part', generation: 1,
      kind: 'hidden' as const, steps: [{ id: step.id, key: step.key }] };
    try {
      const displayed = await target.recomputeSolids({ partId: owner.partId, generation: 1, steps: [step] });
      expect(displayed.failures).toEqual([]);
      const legacy = await target.readCachedBodies(owner.steps);
      expect(legacy.bodies[0].coordinateFrame).toBeUndefined();
      const calls: number[] = [];
      const local = await target.readCachedBodies(owner.steps, { owner, limitBytes,
        localMesh: { maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: limitBytes } }, metadata => {
          expect(metadata.owner).toEqual(owner); calls.push(metadata.replyBackingBytes); return true;
        });
      expect(calls).toHaveLength(1); expect(calls[0]).toBeGreaterThan(0);
      expect(local.bodies[0].coordinateFrame?.space).toBe('local');
      expect(local.bodies[0].coordinateFrame?.origin.every(Number.isFinite)).toBe(true);
      expect(local.bodies[0].positions.byteLength).toBeGreaterThan(0);
      expect(local.bodies[0].edgePositions.byteLength).toBeGreaterThan(0);
      expect(local.bodies[0].origins).toEqual(legacy.bodies[0].origins);
      expect(local.bodies[0].positions).not.toBe(legacy.bodies[0].positions);
      expect(await target.acknowledgeMeshReply?.({ ...owner, generation: 2 })).toEqual({ acknowledged: false });
      expect(await target.acknowledgeMeshReply?.(owner)).toEqual({ acknowledged: true });
      expect(await target.releaseReferenceMeshLease?.({ ...owner, generation: 2 })).toEqual({ released: false });
      expect(await target.releaseReferenceMeshLease?.(owner)).toEqual({ released: true });
      expect(local.bodies[0].positions.byteLength).toBeGreaterThan(0);
      const after = await target.readCachedBodies(owner.steps);
      expect(after.bodies[0].positions).toBe(legacy.bodies[0].positions);
      expect(after.bodies[0].coordinateFrame).toBeUndefined();
      const refusedOwner = { ...owner, dispatchId: 'hidden-local-budget-refusal' };
      await expect(target.readCachedBodies(owner.steps, { owner: refusedOwner, limitBytes: 1,
        localMesh: { maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 1 } })).rejects.toThrow();
      expect(await target.releaseReferenceMeshLease?.(refusedOwner)).toEqual({ released: false, absent: true });
      expect((await target.readCachedBodies(owner.steps)).bodies[0].positions).toBe(legacy.bodies[0].positions);
    } finally { await target.acknowledgeMeshReply?.(owner); await target.releaseReferenceMeshLease?.(owner); await target.releasePart(owner.partId); }
  });

  it('public recompute requestのlocal opt-in後もcacheはworldを返し計測値を保持する', async () => {
    const target = createKernelApi(loadOcctForNode);
    const partId = 'local-frame-api';
    const steps = [extrudeStep('local-body', 'local-body-key', 10)];
    try {
      const first = await target.recomputeSolids({ partId, generation: 1, steps,
        localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } });
      expect(first.failures).toEqual([]);
      expect(first.bodies[0].coordinateFrame?.space).toBe('local');
      expect((await target.getShapeCacheStats()).meshBytes).toBeGreaterThan(0);
      const world = await target.recomputeSolids({ partId, generation: 2, steps });
      expect(world.failures).toEqual([]);
      expect(world.cacheHits).toBe(1);
      expect(world.bodies[0].coordinateFrame).toBeUndefined();
      const localHit = await target.recomputeSolids({ partId, generation: 3, steps,
        localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } });
      expect(localHit.failures).toEqual([]);
      expect(localHit.cacheHits).toBe(1);
      expect(localHit.bodies[0].coordinateFrame?.space).toBe('local');
      expect(localHit.bodies[0].positions).not.toBe(world.bodies[0].positions);
    } finally {
      await target.releasePart(partId);
    }
  });

  it('作れない段は例外にせず、理由つきの失敗として返す(FR-504)', async () => {
    const result = await api.recomputeSolids({
      steps: [extrudeStep('extrude-1', 'api-bad', 0), extrudeStep('extrude-2', 'api-good', 10)],
      generation: 1,
    });

    expect(result.failures).toEqual([
      { id: 'extrude-1', message: '押し出す長さは 0 より大きい数にしてください。' },
    ]);
    expect(result.bodies.map((body) => body.id)).toEqual(['extrude-2']);
  });

  it('スケッチの曲線を折れ線にして返す', async () => {
    const result = await api.tessellateSketch({
      curves: [
        { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
        {
          kind: 'arc',
          center: [0, 0, 0],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
          radius: 10,
          startAngle: 0,
          endAngle: Math.PI / 2,
        },
      ],
      faces: [],
    });
    expect(result.curvePolylines).toHaveLength(2);
    // 線分は 2 点 × 3 座標。円弧は既定の粗さ(0.1mm)で実測 7 点。
    expect(result.curvePolylines[0]).toHaveLength(6);
    expect(result.curvePolylines[1].length).toBeGreaterThan(6);
    expect(result.curvePolylines[1].length % 3).toBe(0);
    expect(result.faces).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('閉ループから面のメッシュ・法線・境界の稜線を返す(FR-309)', async () => {
    const result = await api.tessellateSketch({
      curves: [],
      faces: [{ id: 'square', curves: SQUARE_CURVES }],
    });
    expect(result.curvePolylines).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.faces).toHaveLength(1);

    const face = result.faces[0];
    expect(face.id).toBe('square');
    expect(face.triangleCount).toBe(2);
    expect(face.indices.length).toBe(6);
    expect(face.positions.length / 3).toBe(4);
    expect(face.normals.length).toBe(face.positions.length);
    // 作図面 XY の法線 (0,0,1) と一致する。
    for (let index = 0; index + 2 < face.normals.length; index += 3) {
      expect(face.normals[index]).toBeCloseTo(0, 6);
      expect(face.normals[index + 1]).toBeCloseTo(0, 6);
      expect(face.normals[index + 2]).toBeCloseTo(1, 6);
    }
    // 境界は 4 本の線分。1 本あたり 6 個(始点 xyz + 終点 xyz)。
    expect(face.boundaryEdgeCount).toBe(4);
    expect(face.boundaryPositions.length).toBe(24);

    // Comlink 越しに渡せる型(TypedArray と純データ)だけを使っている。
    expect(face.positions).toBeInstanceOf(Float32Array);
    expect(face.normals).toBeInstanceOf(Float32Array);
    expect(face.indices).toBeInstanceOf(Uint32Array);
    expect(face.boundaryPositions).toBeInstanceOf(Float32Array);
  });

  it('面が 1 枚失敗しても残りは作る(FR-504、NFR-RE-1)', async () => {
    const broken: readonly CurveSpec[] = [
      { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
      { kind: 'segment', from: [50, 50, 0], to: [60, 50, 0] },
    ];
    const result = await api.tessellateSketch({
      curves: [],
      faces: [
        { id: 'ok', curves: SQUARE_CURVES },
        { id: 'ng', curves: broken },
      ],
    });
    expect(result.faces.map((face) => face.id)).toEqual(['ok']);
    expect(result.faces[0].triangleCount).toBe(2);
    expect(result.failures).toEqual([
      { id: 'ng', message: '選んだ線・円弧がつながっていないため、輪郭を作れませんでした。' },
    ]);
  });

  it('輪郭をずらした曲線を、1 回の依頼でまとめて返す(FR-321)', async () => {
    // 40×30 の長方形を外へ 5(尖った角)→ 50×40 の線分 4 本。
    // 同じ長方形を内へ 5 → 30×20 の線分 4 本。周の長さは 180 と 100(手計算)。
    const result = await api.offsetSketchCurves({
      items: [
        { id: 'outside', curves: RECTANGLE_CURVES, distance: 5, joinType: 'intersection' },
        { id: 'inside', curves: RECTANGLE_CURVES, distance: -5, joinType: 'intersection' },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.results.map((entry) => entry.id)).toEqual(['outside', 'inside']);
    for (const entry of result.results) {
      expect(entry.contours).toHaveLength(1);
      expect(entry.contours[0].closed).toBe(true);
      expect(entry.contours[0].curves).toHaveLength(4);
    }

    const outside = result.results[0].contours[0].curves;
    const inside = result.results[1].contours[0].curves;
    expect(perimeterOf(outside)).toBeCloseTo(180, 6);
    expect(perimeterOf(inside)).toBeCloseTo(100, 6);
  });

  it('丸い角を頼むと、線分 4 本と半径 5 の円弧 4 本が返る(FR-321)', async () => {
    const result = await api.offsetSketchCurves({
      items: [{ id: 'round', curves: RECTANGLE_CURVES, distance: 5, joinType: 'arc' }],
    });

    expect(result.failures).toEqual([]);
    const curves = result.results[0].contours[0].curves;
    expect(curves.filter((curve) => curve.kind === 'segment')).toHaveLength(4);
    const arcs = curves.filter((curve) => curve.kind === 'arc');
    expect(arcs).toHaveLength(4);
    for (const arc of arcs) {
      expect(arc.radius).toBeCloseTo(5, 9);
    }
  });

  it('ずらせない依頼は例外にせず、理由つきの失敗として返す(FR-504、NFR-RE-1)', async () => {
    const circle: readonly CurveSpec[] = [
      {
        kind: 'arc',
        center: [0, 0, 0],
        normal: [0, 0, 1],
        xAxis: [1, 0, 0],
        radius: 10,
        startAngle: 0,
        endAngle: 2 * Math.PI,
      },
    ];
    const result = await api.offsetSketchCurves({
      items: [
        { id: 'ng', curves: circle, distance: -15, joinType: 'arc' },
        { id: 'ok', curves: circle, distance: -3, joinType: 'arc' },
      ],
    });

    expect(result.failures).toEqual([
      { id: 'ng', message: 'これ以上内側にはオフセットできません。' },
    ]);
    expect(result.results.map((entry) => entry.id)).toEqual(['ok']);
    const arc = result.results[0].contours[0].curves[0];
    if (arc.kind !== 'arc') {
      throw new Error('円弧が返るはず');
    }
    expect(arc.radius).toBeCloseTo(7, 9);
  });

  // ------------------------------------------------------------------
  // 投影・交差(FR-325、P4 タスク25)。形状キャッシュの鍵でもとの立体を引く。
  // ------------------------------------------------------------------

  /** XY と平行な作図面(第 1 軸 = X)。2 次元座標はそのまま (x, y) になる。 */
  function xyPlaneAt(z: number): SketchPlaneFrame {
    return { origin: [0, 0, z], axisU: [1, 0, 0], normal: [0, 0, 1] };
  }

  /** 作図面の上の線分の列がなす閉じた輪郭の面積(靴ひもの公式)。 */
  function planeAreaOf(curves: readonly PlaneCurve[]): number {
    let twice = 0;
    for (const curve of curves) {
      if (curve.kind !== 'segment') {
        throw new Error(`線分が返るはず: ${curve.kind}`);
      }
      twice += curve.from[0] * curve.to[1] - curve.to[0] * curve.from[1];
    }
    return Math.abs(twice) / 2;
  }

  /** 40×30×10 の板を作り、その段の鍵と面の一覧を返す。 */
  async function makePlate(key: string): Promise<SolidBodyMesh> {
    const result = await api.recomputeSolids({
      steps: [extrudeStep('plate', key, 10)],
      generation: 1,
    });
    expect(result.failures).toEqual([]);
    return result.bodies[0];
  }

  /** 一覧の中から、指定した向きの平らな面の指紋を作る。 */
  function planeFaceQuery(body: SolidBodyMesh, height: number): SubShapeQuery {
    const found = body.faces.find(
      (face) =>
        face.surfaceKind === 'plane' &&
        face.axis !== null &&
        Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 &&
        Math.abs(face.centroid[2] - height) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(`z=${height} の平らな面が見つかりません`);
    }
    return {
      kind: 'face',
      index: found.index,
      surfaceKind: found.surfaceKind,
      area: found.area,
      position: found.centroid,
      axis: found.axis,
      radius: found.radius,
    };
  }

  it('板の上面を XY 面へ投影すると、線分 4 本・面積 1200 の長方形になる(FR-325)', async () => {
    const body = await makePlate('api-project-plate');
    const result = await api.projectSketchCurves({
      items: [
        {
          id: 'proj-1',
          shapeKey: 'api-project-plate',
          subShape: planeFaceQuery(body, 10),
          plane: xyPlaneAt(0),
        },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.results).toHaveLength(1);
    const curves = result.results[0].curves;
    expect(curves).toHaveLength(4);
    expect(planeAreaOf(curves)).toBeCloseTo(1200, 6);
  });

  it('立体そのもの(部分形状の指定なし)を投影すると、潰れない辺だけが返る', async () => {
    await makePlate('api-project-whole');
    const result = await api.projectSketchCurves({
      items: [
        { id: 'proj-2', shapeKey: 'api-project-whole', subShape: null, plane: xyPlaneAt(0) },
      ],
    });

    expect(result.failures).toEqual([]);
    // 箱の 12 辺のうち、作図面の法線と平行な縦 4 本は点に潰れるので 8 本(makeProjection.test.ts)。
    expect(result.results[0].curves).toHaveLength(8);
  });

  it('もとの立体が形状キャッシュに無い依頼は、例外にせず理由つきの失敗にする(FR-504)', async () => {
    const result = await api.projectSketchCurves({
      items: [{ id: 'proj-3', shapeKey: 'api-no-such-key', subShape: null, plane: xyPlaneAt(0) }],
    });

    expect(result.results).toEqual([]);
    expect(result.failures).toEqual([
      {
        id: 'proj-3',
        message: 'もとになる立体が見つかりませんでした。もう一度計算し直してください。',
      },
    ]);
  });

  it('指紋に合う面が無い依頼は、例外にせず理由つきの失敗にする(FR-504)', async () => {
    await makePlate('api-project-missing');
    const result = await api.projectSketchCurves({
      items: [
        {
          id: 'proj-4',
          shapeKey: 'api-project-missing',
          // 球面は板に 1 枚も無いので、種類の一致条件で候補が 0 になる。
          subShape: {
            kind: 'face',
            index: 99,
            surfaceKind: 'sphere',
            area: 1,
            position: [0, 0, 0],
            axis: null,
            radius: 1,
          },
          plane: xyPlaneAt(0),
        },
      ],
    });

    expect(result.results).toEqual([]);
    expect(result.failures[0].id).toBe('proj-4');
    expect(result.failures[0].message).toContain('形が大きく変わったため、選び直してください。');
  });

  it('板を z=5 の作図面で切ると、線分 4 本・面積 1200 の断面になる(FR-325)', async () => {
    await makePlate('api-section-plate');
    const result = await api.sectionSketchCurves({
      items: [{ id: 'sec-1', shapeKey: 'api-section-plate', plane: xyPlaneAt(5) }],
    });

    expect(result.failures).toEqual([]);
    const curves = result.results[0].curves;
    expect(curves).toHaveLength(4);
    expect(planeAreaOf(curves)).toBeCloseTo(1200, 6);
  });

  it('交わらない作図面で切っても失敗にせず、曲線 0 本で返す(呼び出し側が断る)', async () => {
    await makePlate('api-section-away');
    const result = await api.sectionSketchCurves({
      items: [{ id: 'sec-2', shapeKey: 'api-section-away', plane: xyPlaneAt(50) }],
    });

    expect(result.failures).toEqual([]);
    expect(result.results).toEqual([{ id: 'sec-2', curves: [] }]);
  });

  it('1 件失敗しても残りの投影は作る(FR-504、NFR-RE-1)', async () => {
    const body = await makePlate('api-project-mixed');
    const result = await api.projectSketchCurves({
      items: [
        { id: 'ng', shapeKey: 'api-no-such-key', subShape: null, plane: xyPlaneAt(0) },
        {
          id: 'ok',
          shapeKey: 'api-project-mixed',
          subShape: planeFaceQuery(body, 0),
          plane: xyPlaneAt(0),
        },
      ],
    });

    expect(result.failures.map((failure) => failure.id)).toEqual(['ng']);
    expect(result.results.map((entry) => entry.id)).toEqual(['ok']);
    expect(planeAreaOf(result.results[0].curves)).toBeCloseTo(1200, 6);
  });

  // ------------------------------------------------------------------
  // 測定と質量特性(FR-1101、FR-1102、P5 タスク28)。
  // 投影と同じく形状キャッシュの鍵で覚えてある形を引き、再計算は起こさない。
  // ------------------------------------------------------------------

  /** 40×30 の長方形を X 方向へ offsetX だけずらした輪郭。 */
  function rectangleAt(offsetX: number): readonly CurveSpec[] {
    return [
      { kind: 'segment', from: [offsetX, 0, 0], to: [offsetX + 40, 0, 0] },
      { kind: 'segment', from: [offsetX + 40, 0, 0], to: [offsetX + 40, 30, 0] },
      { kind: 'segment', from: [offsetX + 40, 30, 0], to: [offsetX, 30, 0] },
      { kind: 'segment', from: [offsetX, 30, 0], to: [offsetX, 0, 0] },
    ];
  }

  /** ずらした長方形を Z へ 10 押し出す 1 段。 */
  function offsetPlateStep(id: string, key: string, offsetX: number): SolidStepRequest {
    return {
      key,
      id,
      label: id,
      visible: true,
      step: { kind: 'extrude', profile: rectangleAt(offsetX), direction: [0, 0, 1], distance: 10 },
    };
  }

  /** 20×20×20 の立方体。アセンブリ配置つき測定で同じキャッシュ形状を使い回す。 */
  function cube20Step(key: string): SolidStepRequest {
    const profile: readonly CurveSpec[] = [
      { kind: 'segment', from: [0, 0, 0], to: [20, 0, 0] },
      { kind: 'segment', from: [20, 0, 0], to: [20, 20, 0] },
      { kind: 'segment', from: [20, 20, 0], to: [0, 20, 0] },
      { kind: 'segment', from: [0, 20, 0], to: [0, 0, 0] },
    ];
    return {
      key, id: key, label: key, visible: true,
      step: { kind: 'extrude', profile, direction: [0, 0, 1], distance: 20 },
    };
  }

  /** 頂点の指紋。位置がそのまま照合の材料になる(matchVertex)。 */
  function vertexQueryAt(body: SolidBodyMesh, position: readonly number[]): SubShapeQuery {
    const found = body.vertices.find(
      (vertex) =>
        Math.abs(vertex.position[0] - position[0]) < 1e-9 &&
        Math.abs(vertex.position[1] - position[1]) < 1e-9 &&
        Math.abs(vertex.position[2] - position[2]) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(`頂点 (${position.join(', ')}) が見つかりません`);
    }
    return { kind: 'vertex', index: found.index, position: found.position };
  }

  it('覚えてある立体の体積・表面積・重心・主慣性を測る(FR-1101)', async () => {
    await makePlate('api-measure-mass');
    const result = await api.measure({
      targets: [{ bodyKey: 'api-measure-mass', subShape: null }],
      kind: 'massProperties',
    });

    expect(result.kind).toBe('massProperties');
    if (result.kind !== 'massProperties') {
      return;
    }
    // 40×30×10 の板: 体積 12000 mm³、表面積 2(1200+400+300) = 3800 mm²、重心 (20,15,5)。
    expect(result.volume).toBeCloseTo(12000, 6);
    expect(result.area).toBeCloseTo(3800, 6);
    expect(result.centreOfMass[0]).toBeCloseTo(20, 9);
    expect(result.centreOfMass[1]).toBeCloseTo(15, 9);
    expect(result.centreOfMass[2]).toBeCloseTo(5, 9);
    // V(b²+c²)/12 の 3 通り(手計算)。主軸の並びは形しだいなので順不同で比べる。
    const sorted = [...result.principalMoments].sort((a, b) => a - b);
    expect(sorted[0]).toBeCloseTo(1000000, 3);
    expect(sorted[1]).toBeCloseTo(1700000, 3);
    expect(sorted[2]).toBeCloseTo(2500000, 3);
    expect(result.principalAxes).toHaveLength(3);
  });

  it('5 mm 離れた 2 つの立体の最短距離は 5 mm(FR-1102)', async () => {
    const result = await api.recomputeSolids({
      steps: [
        offsetPlateStep('plate-near', 'api-measure-near', 0),
        offsetPlateStep('plate-far', 'api-measure-far', 45),
      ],
      generation: 1,
    });
    expect(result.failures).toEqual([]);

    const measured = await api.measure({
      targets: [
        { bodyKey: 'api-measure-near', subShape: null },
        { bodyKey: 'api-measure-far', subShape: null },
      ],
      kind: 'distance',
    });

    expect(measured.kind).toBe('distance');
    if (measured.kind !== 'distance') {
      return;
    }
    // 板は x=0〜40 と x=45〜85 なので隙間は 5 mm(手計算)。
    expect(measured.distance).toBeCloseTo(5, 6);
    expect(measured.inner).toBe(false);
    expect(measured.pointA[0]).toBeCloseTo(40, 6);
    expect(measured.pointB[0]).toBeCloseTo(45, 6);
  });

  it('同じ20 mm立方体を現在配置へ移して測り、中心間50 mmなら隙間30 mm・重なれば0 mm(P7 タスク26)', async () => {
    const key = 'api-measure-placed-cube';
    const result = await api.recomputeSolids({ steps: [cube20Step(key)], generation: 1 });
    expect(result.failures).toEqual([]);
    const target = (x: number) => ({
      bodyKey: key,
      subShape: null,
      placement: { position: [x, 0, 0] as const, rotation: [0, 0, 0, 1] as const },
    });

    const separated = await api.measure({
      targets: [target(0), target(50)], kind: 'distance',
    });
    expect(separated).toMatchObject({ kind: 'distance', distance: 30, inner: false });

    const overlapping = await api.measure({
      targets: [target(0), target(15)], kind: 'distance',
    });
    expect(overlapping).toMatchObject({ kind: 'distance', distance: 0 });
  });

  it('指紋で選び直した面どうしの距離を測る(FR-1102)', async () => {
    const result = await api.recomputeSolids({
      steps: [
        offsetPlateStep('plate-near', 'api-measure-face-near', 0),
        offsetPlateStep('plate-far', 'api-measure-face-far', 45),
      ],
      generation: 1,
    });
    expect(result.failures).toEqual([]);

    const measured = await api.measure({
      targets: [
        { bodyKey: 'api-measure-face-near', subShape: planeFaceQuery(result.bodies[0], 10) },
        { bodyKey: 'api-measure-face-far', subShape: planeFaceQuery(result.bodies[1], 10) },
      ],
      kind: 'distance',
    });

    expect(measured.kind).toBe('distance');
    if (measured.kind !== 'distance') {
      return;
    }
    // 同じ高さ(z=10)にある 2 枚の上面は、x の隙間ぶんだけ離れている。
    expect(measured.distance).toBeCloseTo(5, 6);
  });

  it('頂点の指紋どうしの距離は対角線の長さになる(FR-1102)', async () => {
    const body = await makePlate('api-measure-vertex');
    const measured = await api.measure({
      targets: [
        { bodyKey: 'api-measure-vertex', subShape: vertexQueryAt(body, [0, 0, 0]) },
        { bodyKey: 'api-measure-vertex', subShape: vertexQueryAt(body, [40, 30, 10]) },
      ],
      kind: 'distance',
    });

    expect(measured.kind).toBe('distance');
    if (measured.kind !== 'distance') {
      return;
    }
    // √(40² + 30² + 10²) = √2600 = 50.99019513592785(手計算)。
    expect(measured.distance).toBeCloseTo(50.99019513592785, 6);
  });

  it('鍵が形状キャッシュに無いときは、投げずに「もう一度お試しください。」で断る(NFR-RE-1)', async () => {
    const measured = await api.measure({
      targets: [{ bodyKey: 'api-measure-no-such-key', subShape: null }],
      kind: 'massProperties',
    });

    expect(measured.kind).toBe('failed');
    if (measured.kind !== 'failed') {
      return;
    }
    expect(measured.message).toContain('もう一度お試しください。');
  });

  it('指紋に合う面が無いときも、投げずに理由つきで断る(FR-504)', async () => {
    await makePlate('api-measure-missing-face');
    const measured = await api.measure({
      targets: [
        {
          bodyKey: 'api-measure-missing-face',
          // 球面は板に 1 枚も無いので、種類の一致条件で候補が 0 になる。
          subShape: {
            kind: 'face',
            index: 99,
            surfaceKind: 'sphere',
            area: 1,
            position: [0, 0, 0],
            axis: null,
            radius: 1,
          },
        },
      ],
      kind: 'massProperties',
    });

    expect(measured.kind).toBe('failed');
    if (measured.kind !== 'failed') {
      return;
    }
    expect(measured.message).toContain('形が大きく変わったため、選び直してください。');
  });

  it('対象の件数が合わないときは、測るものごとの断りを返す', async () => {
    await makePlate('api-measure-count');
    const one = await api.measure({
      targets: [{ bodyKey: 'api-measure-count', subShape: null }],
      kind: 'distance',
    });
    expect(one).toEqual({ kind: 'failed', message: '距離を測るには 2 つ選んでください。' });

    const two = await api.measure({
      targets: [
        { bodyKey: 'api-measure-count', subShape: null },
        { bodyKey: 'api-measure-count', subShape: null },
      ],
      kind: 'massProperties',
    });
    expect(two).toEqual({
      kind: 'failed',
      message: '体積と重心を測るには立体を 1 つ選んでください。',
    });
  });

  it('測定は再計算を起こさない(次の再計算でも段はすべてキャッシュに当たる)', async () => {
    const request = {
      steps: [extrudeStep('plate', 'api-measure-no-recompute', 10)],
      generation: 1,
    };
    const first = await api.recomputeSolids(request);
    expect(first.failures).toEqual([]);

    const measured = await api.measure({
      targets: [{ bodyKey: 'api-measure-no-recompute', subShape: null }],
      kind: 'massProperties',
    });
    expect(measured.kind).toBe('massProperties');

    const second = await api.recomputeSolids(request);
    // 測ったせいで形が捨てられていれば 0 になる。1 なら形はそのまま残っている。
    expect(second.cacheHits).toBe(1);
  });

  it('穴 20 個の板の質量特性 1 回の所要を実測して記録する(NFR-PF-4)', async () => {
    const plate = await api.recomputeSolids({
      steps: [
        {
          key: 'api-measure-holes-plate',
          id: 'plate',
          label: 'plate',
          visible: true,
          step: {
            kind: 'extrude',
            profile: rectangleAt(0),
            direction: [0, 0, 1],
            distance: 10,
          },
        },
      ],
      generation: 1,
    });
    expect(plate.failures).toEqual([]);

    // 40×30 の板に φ6 の貫通穴を 20 個(5 列 × 4 行)。
    const centers: [number, number, number][] = [];
    for (let column = 0; column < 5; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        centers.push([6 + column * 7, 5 + row * 6.5, 10]);
      }
    }
    expect(centers).toHaveLength(20);

    const hole: HoleStepSpec = {
      kind: 'hole',
      targetKey: 'api-measure-holes-plate',
      face: planeFaceQuery(plate.bodies[0], 10),
      centers,
      diameter: 3,
      depth: null,
      tiltAngle: 0,
      tiltAzimuth: 0,
      transforms: [],
    };
    const drilled = await api.recomputeSolids({
      steps: [
        {
          key: 'api-measure-holes-plate',
          id: 'plate',
          label: 'plate',
          visible: false,
          step: {
            kind: 'extrude',
            profile: rectangleAt(0),
            direction: [0, 0, 1],
            distance: 10,
          },
        },
        { key: 'api-measure-holes', id: 'holes', label: 'holes', visible: true, step: hole },
      ],
      generation: 2,
    });
    expect(drilled.failures).toEqual([]);

    const startedAt = performance.now();
    const measured = await api.measure({
      targets: [{ bodyKey: 'api-measure-holes', subShape: null }],
      kind: 'massProperties',
    });
    const elapsedMs = performance.now() - startedAt;
    console.log(`穴 20 個の板(40×30×10・φ3)の質量特性 1 回: ${elapsedMs.toFixed(1)} ms`);

    expect(measured.kind).toBe('massProperties');
    if (measured.kind !== 'massProperties') {
      return;
    }
    // 12000 − 20 × π × 1.5² × 10 = 12000 − 1413.7166941154069(手計算)。
    expect(measured.volume).toBeCloseTo(10586.283305884594, 4);
    expect(elapsedMs).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 書き出しと読み込み(FR-802、FR-803。P6 §2.3・§2.4・§2.8、タスク10)。
  //
  // **口は書き出し 1 本・読み込み 1 本しか無い**(§0.a-0.2)ので、形式ごとの検査も
  // 同じ 2 本を `format` を変えて呼ぶ形になる。「未知の形式で断る」検査は書かない
  // ——未知の形式は依頼の型(判別共用体)に存在せず**型検査で落ちる**からで、
  // 実行時の分岐に `default` を作らないことがその唯一の歯止めである。
  // ---------------------------------------------------------------------------

  /** 書き出しの材料。40×30 を 10 押し出した板(体積 12000)を 1 段だけ作る。 */
  async function buildPlate(key: string): Promise<void> {
    const built = await api.recomputeSolids({
      steps: [extrudeStep(`板-${key}`, key, 10)],
      generation: 1,
    });
    expect(built.failures).toEqual([]);
    expect(built.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
  }

  /** 書き出しの依頼に載せる立体 1 つ(名前も色も要らない形式のため)。 */
  function exportItem(bodyKey: string): ShapeExportItem {
    return { bodyKey, name: null, color: null };
  }

  /** 面の色の表を組み立てる(`xcafFaceColors.test.ts` の `faceColorMap` と同じ組み立て方)。 */
  function faceColorMap(entries: readonly (readonly [number, RgbTuple])[]): FaceColorMap {
    return new Map<number, RgbTuple>(entries);
  }

  /**
   * GLB(バイナリ glTF)の JSON チャンクを文字列のまま取り出す。
   *
   * `JSON.parse` の戻りは `any` なので、そこから欄をたどると型検査を素通りする
   * (`writeCafMesh.test.ts` の `splitGlb` と同じ理由)。ここでは配線が通っているかだけを
   * 見たいので、文字列に含まれる語の数を数える。
   */
  function glbJsonText(bytes: Uint8Array): string {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    return new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength));
  }

  /** 半径 10・高さ 20 の円柱の段。偏差で三角形の数が変わる形として使う。 */
  function cylinderStep(key: string): SolidStepRequest {
    return {
      key,
      id: '円柱',
      label: '円柱',
      visible: true,
      step: {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: { kind: 'cylinder', radius: 10, height: 20 },
        originQuery: null,
        targetKey: null,
      },
    };
  }

  it('exportShapes({ format: "step" }) は AP214 の STEP のバイト列を返す(タスク7)', async () => {
    await buildPlate('api-export-step');
    const written = await api.exportShapes({
      format: 'step',
      bodies: [{ bodyKey: 'api-export-step', name: '本体', color: [1, 0.5, 0.25] }],
    });

    expect(written.format).toBe('step');
    if (written.format !== 'step') {
      return;
    }
    const text = new TextDecoder().decode(written.bytes);
    // 先頭と末尾は STEP(ISO 10303-21)の決まり。書式は AP214(AUTOMOTIVE_DESIGN)。
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain('AUTOMOTIVE_DESIGN');
    expect(text).toContain('END-ISO-10303-21;');
    // 名前は PRODUCT の行に日本語のまま入る(タスク7 の実測)。
    expect(text).toContain('本体');
    expect(written.colorWritten).toBe(true);
    expect(text).toContain('COLOUR_RGB');
  });

  it('公開APIで共有定義・入れ子・配置をSTEPへ書き、同じ構造と体積へ戻す(FR-802、FR-804)', async () => {
    const firstKey = 'api-assembly-first';
    const secondKey = 'api-assembly-second';
    const built = await api.recomputeSolids({
      steps: [
        extrudeStep('長い板', firstKey, 10),
        extrudeStep('薄い板', secondKey, 5),
      ],
      generation: 1,
    });
    expect(built.failures).toEqual([]);

    const nested: ShapeAssemblyNode = {
      kind: 'assembly',
      id: 'subassembly',
      name: '子組立',
      placement: {
        position: [0, 50, 0],
        rotation: [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)],
      },
      children: [{
        kind: 'part',
        id: 'long-2',
        name: '長い板:2',
        definitionId: 'long',
        placement: {
          position: [7, 11, 13],
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        },
      }],
    };
    const assembly: ShapeExportAssembly = {
      name: '主組立',
      definitions: [
        {
          id: 'long',
          name: '長い板',
          bodies: [{ bodyKey: firstKey, name: '長い板', color: [0.8, 0.2, 0.1] }],
        },
        {
          id: 'thin',
          name: '薄い板',
          bodies: [{ bodyKey: secondKey, name: '薄い板', color: null }],
        },
      ],
      children: [
        {
          kind: 'part', id: 'long-1', name: '長い板:1', definitionId: 'long',
          placement: { position: [3, -7, 11], rotation: [0, 0, 0, 1] },
        },
        nested,
        {
          kind: 'part', id: 'thin-1', name: '薄い板:1', definitionId: 'thin',
          placement: { position: [-30, 4, 9], rotation: [0, 0, 0, 1] },
        },
      ],
    };

    const written = await api.exportShapes({ format: 'step', bodies: [], assembly });
    expect(written.format).toBe('step');
    if (written.format !== 'step') return;
    const text = new TextDecoder().decode(written.bytes);
    expect(text.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(2);
    expect(text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)).toHaveLength(4);

    const read = await api.importShape({ format: 'step', bytes: written.bytes });
    expect(read.bodies.map((body) => body.volume).sort((a, b) => a - b)).toEqual([6000, 12000]);
    expect(read.assembly?.name).toBe('主組立');
    expect(read.assembly?.definitions).toHaveLength(2);
    expect(read.assembly?.children).toHaveLength(3);
    const readNested = read.assembly?.children.find((node) => node.kind === 'assembly');
    expect(readNested?.kind).toBe('assembly');
    if (readNested?.kind !== 'assembly') throw new Error('子組立が戻りませんでした。');
    expect(readNested.name).toBe('子組立');
    expect(readNested.placement.position).toEqual([0, 50, 0]);
    expect(readNested.children).toHaveLength(1);
    expect(readNested.children[0]?.placement.position).toEqual([7, 11, 13]);
    expect(readNested.children[0]?.placement.rotation[2]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(readNested.children[0]?.placement.rotation[3]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('アセンブリ定義内の形状鍵が欠けていれば、空の直下bodiesでも書き出しを断る', async () => {
    const assembly: ShapeExportAssembly = {
      name: '欠落検査',
      definitions: [{
        id: 'missing-definition',
        name: null,
        bodies: [exportItem('api-assembly-missing')],
      }],
      children: [{
        kind: 'part', id: 'missing-part', name: null, definitionId: 'missing-definition',
        placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      }],
    };
    await expect(api.exportShapes({ format: 'step', bodies: [], assembly })).rejects.toMatchObject({
      name: 'MissingBodiesError',
      missingKeys: ['api-assembly-missing'],
    });
  });

  it('色を書かない指定では colorWritten が false になり、色の行が入らない(§0.a-0.22)', async () => {
    await buildPlate('api-export-step-nocolor');
    const written = await api.exportShapes({
      format: 'step',
      bodies: [{ bodyKey: 'api-export-step-nocolor', name: '本体', color: [1, 0.5, 0.25] }],
      withColors: false,
    });

    expect(written.format).toBe('step');
    if (written.format !== 'step') {
      return;
    }
    expect(written.colorWritten).toBe(false);
    expect(new TextDecoder().decode(written.bytes)).not.toContain('COLOUR_RGB');
  });

  it('exportShapes({ format: "mesh" }) は立体ごとの三角形を返す(板は 12 枚)', async () => {
    await buildPlate('api-export-mesh');
    const exported = await api.exportShapes({
      format: 'mesh',
      bodies: [exportItem('api-export-mesh')],
      deviationMm: 0.1,
    });

    expect(exported.format).toBe('mesh');
    if (exported.format !== 'mesh') {
      return;
    }
    expect(exported.bodies).toHaveLength(1);
    // 依頼の鍵をそのまま返す(並びも依頼のまま)。
    expect(exported.bodies[0].bodyKey).toBe('api-export-mesh');
    // 直方体は面 6 枚 × 三角形 2 枚 = 12 枚。平面だけなので偏差に依らない。
    expect(exported.bodies[0].triangles.triangleCount).toBe(12);
    expect(exported.bodies[0].triangles.indices).toHaveLength(36);
    expect(exported.bodies[0].triangles.positions.length % 3).toBe(0);
  });

  it('偏差を細かくすると円柱の三角形が増え、画面用のキャッシュは汚れない(§0.a-0.13)', async () => {
    const key = 'api-export-mesh-cylinder';
    const built = await api.recomputeSolids({ steps: [cylinderStep(key)], generation: 1 });
    expect(built.failures).toEqual([]);
    const screenTriangles = built.bodies[0].triangleCount;

    const coarse = await api.exportShapes({
      format: 'mesh',
      bodies: [exportItem(key)],
      deviationMm: 0.5,
    });
    const fine = await api.exportShapes({
      format: 'mesh',
      bodies: [exportItem(key)],
      deviationMm: 0.02,
    });
    expect(coarse.format).toBe('mesh');
    expect(fine.format).toBe('mesh');
    if (coarse.format !== 'mesh' || fine.format !== 'mesh') {
      return;
    }
    expect(fine.bodies[0].triangles.triangleCount).toBeGreaterThan(
      coarse.bodies[0].triangles.triangleCount,
    );

    // 同じ鍵で計算し直すとキャッシュに当たる。**書き出しで作った細かい三角形が
    // 画面用の形へ書き込まれていたら、ここの枚数が変わってしまう。**
    const again = await api.recomputeSolids({ steps: [cylinderStep(key)], generation: 2 });
    expect(again.cacheHits).toBe(1);
    expect(again.bodies[0].triangleCount).toBe(screenTriangles);
  });

  it('exportShapes({ format: "brep" }) は立体ごとのバイト列を返す(タスク9)', async () => {
    await buildPlate('api-export-brep');
    const exported = await api.exportShapes({
      format: 'brep',
      bodies: [exportItem('api-export-brep')],
    });

    expect(exported.format).toBe('brep');
    if (exported.format !== 'brep') {
      return;
    }
    expect(exported.bodies).toHaveLength(1);
    expect(exported.bodies[0].bodyKey).toBe('api-export-brep');
    expect(exported.bodies[0].bytes.length).toBeGreaterThan(0);

    // 書いたバイト列は、そのまま読み込みの口へ渡して形に戻せる(`.pcad` の往復)。
    const read = await api.importShape({ format: 'brep', bytes: exported.bodies[0].bytes });
    expect(read.bodies).toHaveLength(1);
    expect(read.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
    expect(read.bodies[0].bodyKind).toBe('solid');
    expect(read.bodies[0].triangles.triangleCount).toBe(12);
    // B-rep のバイト列にはファイルの単位が無い(内部単位そのもの)。
    expect(read.unit).toBe('mm');
    expect(read.unitNames).toEqual([]);
  });

  it('鍵の見つからない立体を書き出そうとすると、日本語の理由で断る', async () => {
    await expect(
      api.exportShapes({ format: 'brep', bodies: [exportItem('api-export-missing')] }),
    ).rejects.toThrow('もとになる立体が見つかりませんでした。もう一度計算し直してください。');
  });

  it('importShape({ format: "step" }) は形・体積・単位を返す(タスク8)', async () => {
    await buildPlate('api-import-step');
    const written = await api.exportShapes({
      format: 'step',
      bodies: [{ bodyKey: 'api-import-step', name: '本体', color: [1, 0.5, 0.25] }],
    });
    expect(written.format).toBe('step');
    if (written.format !== 'step') {
      return;
    }

    const read = await api.importShape({ format: 'step', bytes: written.bytes });
    expect(read.bodies).toHaveLength(1);
    expect(read.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
    expect(read.bodies[0].bodyKind).toBe('solid');
    expect(read.bodies[0].triangles.triangleCount).toBe(12);
    // 内部は mm 固定(NFR-RE-3)。mm で書いた STEP は `millimetre` として読める。
    expect(read.unit).toBe('mm');
    expect(read.unitNames).toEqual(['millimetre']);
  });

  it('STEP の名前と色は往復して戻り、B-rep のバイト列も一緒に返る(FR-802)', async () => {
    await buildPlate('api-import-step-name');
    const written = await api.exportShapes({
      format: 'step',
      bodies: [{ bodyKey: 'api-import-step-name', name: '取っ手', color: [1, 0.5, 0.25] }],
    });
    expect(written.format).toBe('step');
    if (written.format !== 'step') {
      return;
    }

    const read = await api.importShape({ format: 'step', bytes: written.bytes });
    const body = read.bodies[0];
    expect(body.name).toBe('取っ手');
    expect(body.color?.[0]).toBeCloseTo(1, 6);
    expect(body.color?.[1]).toBeCloseTo(0.5, 6);
    expect(body.color?.[2]).toBeCloseTo(0.25, 6);

    // STEP は B-rep で入るので、必ず `'solid'` か `'shell'` の枝(= `brepBytes` を持つ)。
    // 三角形しか持たない形(`bodyKind: 'mesh'`)は STL / OBJ / glTF の読み込みだけに出る。
    expect(body.bodyKind).toBe('solid');
    if (body.bodyKind === 'mesh') {
      return;
    }
    // 読み込んだ形は `.pcad` へ抱き込む(§0.a-0.9)。そのバイト列だけで形に戻せる。
    const restored = await api.importShape({ format: 'brep', bytes: body.brepBytes });
    expect(restored.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
    // 抱き込むバイト列に三角形分割は入らない(画面用の三角形より先に作るため。
    // 逆順にすると `BinTools.Write_3` が三角形も一緒に書いて 1.5 倍に膨らむ)。
    expect(body.brepBytes.length).toBeLessThan(6000);
  });

  it('色を読まない指定では色が入らず、形と体積はそのまま返る', async () => {
    await buildPlate('api-import-step-nocolor');
    const written = await api.exportShapes({
      format: 'step',
      bodies: [{ bodyKey: 'api-import-step-nocolor', name: '本体', color: [1, 0.5, 0.25] }],
    });
    expect(written.format).toBe('step');
    if (written.format !== 'step') {
      return;
    }

    const read = await api.importShape({
      format: 'step',
      bytes: written.bytes,
      fileName: 'sample.step',
      withColors: false,
    });
    expect(read.bodies[0].color).toBeNull();
    expect(read.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
  });

  it('壊れたバイト列は、STEP でも B-rep でも日本語の理由で断る(NFR-RE-1)', async () => {
    const broken = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(api.importShape({ format: 'step', bytes: broken })).rejects.toThrow(
      'このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。',
    );
    await expect(api.importShape({ format: 'brep', bytes: broken })).rejects.toThrow(
      '保存されていた形を読めませんでした。データが壊れているおそれがあります。',
    );
  });

  it('読み込んだ形の段(importedSolid)は形を戻し、2 回目はキャッシュに当たる(§2.8)', async () => {
    await buildPlate('api-imported-source');
    const exported = await api.exportShapes({
      format: 'brep',
      bodies: [exportItem('api-imported-source')],
    });
    expect(exported.format).toBe('brep');
    if (exported.format !== 'brep') {
      return;
    }

    const step: SolidStepRequest = {
      key: 'api-imported-solid',
      id: '読み込んだ形',
      label: '読み込んだ形',
      visible: true,
      step: { kind: 'importedSolid', bytes: exported.bodies[0].bytes },
    };

    const first = await api.recomputeSolids({ steps: [step], generation: 1 });
    expect(first.failures).toEqual([]);
    expect(first.bodies).toHaveLength(1);
    expect(first.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
    expect(first.bodies[0].bodyKind).toBe('solid');
    expect(first.bodies[0].faceCount).toBe(6);
    expect(first.cacheHits).toBe(0);

    // 鍵(`.pcad` の中の入れ物の名前)が同じなら、読み込んだ形は必ずキャッシュに当たる。
    const second = await api.recomputeSolids({ steps: [step], generation: 2 });
    expect(second.cacheHits).toBe(1);
    expect(second.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
  });

  it('読み込んだ形の段の上に穴をあけられる(STEP はソリッドなので加工できる。FR-802)', async () => {
    await buildPlate('api-imported-drill-source');
    const exported = await api.exportShapes({
      format: 'brep',
      bodies: [exportItem('api-imported-drill-source')],
    });
    expect(exported.format).toBe('brep');
    if (exported.format !== 'brep') {
      return;
    }

    const base: SolidStepRequest = {
      key: 'api-imported-drill-base',
      id: '読み込んだ形',
      label: '読み込んだ形',
      visible: false,
      step: { kind: 'importedSolid', bytes: exported.bodies[0].bytes },
    };
    // 面の指紋は「実際に作った形から読み取る」(手で番号を作らない)ので、
    // 1 回目だけ画面に出す指定で計算して一覧を受け取る。
    const built = await api.recomputeSolids({
      steps: [{ ...base, visible: true }],
      generation: 1,
    });
    expect(built.failures).toEqual([]);

    const drilled = await api.recomputeSolids({
      steps: [
        base,
        {
          key: 'api-imported-drill-hole',
          id: '穴',
          label: '穴',
          visible: true,
          step: {
            kind: 'hole',
            targetKey: base.key,
            face: planeFaceQuery(built.bodies[0], 10),
            centers: [[20, 15, 10]],
            diameter: 6,
            depth: null,
            tiltAngle: 0,
            tiltAzimuth: 0,
            transforms: [],
          },
        },
      ],
      generation: 2,
    });

    expect(drilled.failures).toEqual([]);
    // 12000 − π × 3² × 10 = 12000 − 282.7433388230814 = 11717.256661176919(手計算)。
    // 桁を落とさないよう式のまま書く(literal では倍精度に収まらない)。
    expect(drilled.bodies[0].volume).toBeCloseTo(
      RECTANGLE_EXTRUDE_VOLUME - Math.PI * 3 * 3 * 10,
      4,
    );
  });

  // -------------------------------------------------------------------------
  // 書き出し・読み込みの段の配線(P6 タスク16、FR-802 / FR-803)。
  //
  // **要件が挙げる 5 形式(STEP / STL / OBJ / glTF / 3MF)がすべて `exportShapes` の
  // 1 本から出ること**と、**読み込みの 5 形式(STEP / B-rep / STL / OBJ / glTF)が
  // `importShape` の 1 本から入ること**をここで固定する(§0.a-0.2「口を増やさない」)。
  // 3MF だけは `packages/io` が ZIP と XML を組むので、kernel は三角形までを返す。
  // -------------------------------------------------------------------------

  /** 半径 10 の球の段。丸い面なので、品質の指定で三角形の数が変わる。 */
  function sphereStep(key: string): SolidStepRequest {
    return {
      key,
      id: '球',
      label: '球',
      visible: true,
      step: {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: { kind: 'sphere', radius: 10 },
        originQuery: null,
        targetKey: null,
      },
    };
  }

  it('exportShapes({ format: "stl" }) はバイナリ STL を 1 ファイル返す(FR-803)', async () => {
    await buildPlate('api-export-stl');
    const written = await api.exportShapes({
      format: 'stl',
      bodies: [exportItem('api-export-stl')],
      deviationMm: 0.1,
    });

    expect(written.format).toBe('stl');
    if (written.format !== 'stl') {
      return;
    }
    expect(written.files).toHaveLength(1);
    expect(written.files[0].fileName).toBe('model.stl');
    // 直方体は面 6 枚 × 三角形 2 枚 = 12 枚。バイナリ STL は 84 + 50 × 12 = 684 バイト(§2.4)。
    expect(written.triangleCount).toBe(12);
    expect(written.droppedTriangleCount).toBe(0);
    expect(written.files[0].bytes.length).toBe(684);
    // 見出し 80 バイトの直後に三角形の数が uint32 リトルエンディアンで入る。
    const view = new DataView(
      written.files[0].bytes.buffer,
      written.files[0].bytes.byteOffset,
      written.files[0].bytes.byteLength,
    );
    expect(view.getUint32(80, true)).toBe(12);
  });

  it('exportShapes({ format: "stl", ascii: true }) は ASCII STL を返す(FR-803)', async () => {
    await buildPlate('api-export-stl-ascii');
    const written = await api.exportShapes({
      format: 'stl',
      bodies: [exportItem('api-export-stl-ascii')],
      deviationMm: 0.1,
      ascii: true,
      baseName: '取っ手 A',
    });

    expect(written.format).toBe('stl');
    if (written.format !== 'stl') {
      return;
    }
    // 名前の空白は `_` へ寄せる(`writeCafMesh.ts` の `normalizeBaseName` が 1 か所の正本。
    // OBJ の `mtllib` の行が空白で切れるのを防ぐ規則を、STL の名前にも同じく掛ける)。
    expect(written.files[0].fileName).toBe('取っ手_A.stl');
    const text = new TextDecoder().decode(written.files[0].bytes);
    expect(text.startsWith('solid ')).toBe(true);
    expect(text.trimEnd().endsWith('endsolid PointerCAD')).toBe(true);
    expect(text.match(/facet normal/gu)).toHaveLength(12);
  });

  it('exportShapes({ format: "obj" }) は .obj と .mtl の 2 ファイルを返す(FR-803)', async () => {
    await buildPlate('api-export-obj');
    const written = await api.exportShapes({
      format: 'obj',
      bodies: [{ bodyKey: 'api-export-obj', name: '本体', color: [1, 0.5, 0.25] }],
      deviationMm: 0.1,
    });

    expect(written.format).toBe('obj');
    if (written.format !== 'obj') {
      return;
    }
    expect(written.files.map((file) => file.fileName)).toEqual(['model.obj', 'model.mtl']);
    const objText = new TextDecoder().decode(written.files[0].bytes);
    // `mtllib` の行が 2 つ目のファイル名を指していないと、色が付かない。
    expect(objText).toContain(`mtllib ${written.files[1].fileName}`);
    expect(objText).toContain('o 本体');
    expect(objText.match(/^f /gmu)).toHaveLength(12);
    const mtlText = new TextDecoder().decode(written.files[1].bytes);
    expect(mtlText.match(/^newmtl /gmu)).toHaveLength(1);
    expect(mtlText).toContain('Kd 1.000000 0.500000 0.250000');
    expect(written.triangleCount).toBe(12);
  });

  it('exportShapes({ format: "gltf" }) は .glb を 1 ファイル返す(FR-803)', async () => {
    await buildPlate('api-export-gltf');
    const written = await api.exportShapes({
      format: 'gltf',
      bodies: [{ bodyKey: 'api-export-gltf', name: '本体', color: null }],
      deviationMm: 0.1,
      baseName: 'plate',
    });

    expect(written.format).toBe('gltf');
    if (written.format !== 'gltf') {
      return;
    }
    expect(written.files).toHaveLength(1);
    expect(written.files[0].fileName).toBe('plate.glb');
    // 先頭 4 バイトが `glTF`、次の 4 バイトが版 2(glTF の仕様)。
    expect([...written.files[0].bytes.slice(0, 4)]).toEqual([0x67, 0x6c, 0x54, 0x46]);
    const view = new DataView(
      written.files[0].bytes.buffer,
      written.files[0].bytes.byteOffset,
      written.files[0].bytes.byteLength,
    );
    expect(view.getUint32(4, true)).toBe(2);
    expect(written.triangleCount).toBe(12);
  });

  // ここから下は面ごとの色(P6 タスク7b+13b)を KernelApi.exportShapes の依頼から
  // 使えるようにする配線の検査(§2.5.1)。表そのものの振る舞い(色の優先順位・
  // 選び直せない面の断りなど)は `occt/xcafFaceColors.test.ts` /
  // `occt/xcafDocument.test.ts` / `occt/writeCafMesh.test.ts` が固定済みなので、
  // ここでは「依頼の `faceColors` が書き手まで届くか」だけを見る。

  it('exportShapes({ format: "step" }) に面の色を渡すと STYLED_ITEM が 1 行増える(タスク7b+13b の配線)', async () => {
    await buildPlate('api-export-step-facecolor');
    const bodyKey = 'api-export-step-facecolor';
    const plain = await api.exportShapes({
      format: 'step',
      bodies: [{ bodyKey, name: '本体', color: [1, 0.5, 0.25] }],
    });
    const withFaceColor = await api.exportShapes({
      format: 'step',
      bodies: [
        {
          bodyKey,
          name: '本体',
          color: [1, 0.5, 0.25],
          faceColors: faceColorMap([[0, [0.2, 0.6, 0.9]]]),
        },
      ],
    });

    expect(plain.format).toBe('step');
    expect(withFaceColor.format).toBe('step');
    if (plain.format !== 'step' || withFaceColor.format !== 'step') {
      return;
    }
    const countStyledItem = (bytes: Uint8Array): number =>
      new TextDecoder().decode(bytes).split('STYLED_ITEM').length - 1;
    // 立体の色(1 行)+ 面の色(1 行)= 2 行(`xcafFaceColors.ts` 冒頭の実測表と同じ)。
    expect(countStyledItem(withFaceColor.bytes)).toBe(countStyledItem(plain.bytes) + 1);
  });

  it('exportShapes({ format: "gltf" }) に面の色を渡すと materials が増える(タスク7b+13b の配線)', async () => {
    await buildPlate('api-export-gltf-facecolor');
    const bodyKey = 'api-export-gltf-facecolor';
    const plain = await api.exportShapes({
      format: 'gltf',
      bodies: [{ bodyKey, name: '本体', color: [1, 0.5, 0.25] }],
      deviationMm: 0.1,
    });
    const withFaceColor = await api.exportShapes({
      format: 'gltf',
      bodies: [
        {
          bodyKey,
          name: '本体',
          color: [1, 0.5, 0.25],
          faceColors: faceColorMap([[0, [0.2, 0.6, 0.9]]]),
        },
      ],
      deviationMm: 0.1,
    });

    expect(plain.format).toBe('gltf');
    expect(withFaceColor.format).toBe('gltf');
    if (plain.format !== 'gltf' || withFaceColor.format !== 'gltf') {
      return;
    }
    // 材質は `baseColorFactor` を持つ要素の数として数える(`JSON.parse` は使わない。
    // 戻りが `any` になり `no-unsafe-member-access` に触れるため)。
    const materialCount = (bytes: Uint8Array): number =>
      glbJsonText(bytes).split('"baseColorFactor"').length - 1;
    expect(materialCount(withFaceColor.files[0].bytes)).toBe(
      materialCount(plain.files[0].bytes) + 1,
    );
  });

  it('exportShapes({ format: "obj" }) に面の色を渡すと .mtl の newmtl が増える(タスク7b+13b の配線)', async () => {
    await buildPlate('api-export-obj-facecolor');
    const bodyKey = 'api-export-obj-facecolor';
    const plain = await api.exportShapes({
      format: 'obj',
      bodies: [{ bodyKey, name: '本体', color: [1, 0.5, 0.25] }],
      deviationMm: 0.1,
    });
    const withFaceColor = await api.exportShapes({
      format: 'obj',
      bodies: [
        {
          bodyKey,
          name: '本体',
          color: [1, 0.5, 0.25],
          faceColors: faceColorMap([[0, [0.2, 0.6, 0.9]]]),
        },
      ],
      deviationMm: 0.1,
    });

    expect(plain.format).toBe('obj');
    expect(withFaceColor.format).toBe('obj');
    if (plain.format !== 'obj' || withFaceColor.format !== 'obj') {
      return;
    }
    const countNewmtl = (bytes: Uint8Array): number =>
      new TextDecoder().decode(bytes).match(/^newmtl /gmu)?.length ?? 0;
    expect(countNewmtl(withFaceColor.files[1].bytes)).toBe(countNewmtl(plain.files[1].bytes) + 1);
  });

  it('面の色を渡さない依頼は、STEP でも glb でも配線を足す前とバイト列が変わらない(回帰なし)', async () => {
    await buildPlate('api-export-facecolor-noop');
    const bodyKey = 'api-export-facecolor-noop';

    const stepWithout = await api.exportShapes({
      format: 'step',
      bodies: [{ bodyKey, name: '本体', color: [1, 0.5, 0.25] }],
    });
    const stepWithEmpty = await api.exportShapes({
      format: 'step',
      bodies: [{ bodyKey, name: '本体', color: [1, 0.5, 0.25], faceColors: faceColorMap([]) }],
    });
    expect(stepWithout.format).toBe('step');
    expect(stepWithEmpty.format).toBe('step');
    if (stepWithout.format === 'step' && stepWithEmpty.format === 'step') {
      expect(stepBytesForComparison(stepWithEmpty.bytes)).toEqual(
        stepBytesForComparison(stepWithout.bytes),
      );
    }

    const gltfWithout = await api.exportShapes({
      format: 'gltf',
      bodies: [{ bodyKey, name: '本体', color: [1, 0.5, 0.25] }],
      deviationMm: 0.1,
    });
    const gltfWithEmpty = await api.exportShapes({
      format: 'gltf',
      bodies: [{ bodyKey, name: '本体', color: [1, 0.5, 0.25], faceColors: faceColorMap([]) }],
      deviationMm: 0.1,
    });
    expect(gltfWithout.format).toBe('gltf');
    expect(gltfWithEmpty.format).toBe('gltf');
    if (gltfWithout.format === 'gltf' && gltfWithEmpty.format === 'gltf') {
      expect(gltfWithEmpty.files[0].bytes).toEqual(gltfWithout.files[0].bytes);
    }
  });

  it('STEP 比較は秒の差だけを除き、それ以外の 1 バイトの差と不正な日時を検出する', () => {
    const text = "ISO-10303-21;\r\nHEADER;\r\nFILE_DESCRIPTION((''),'2;1');\r\n" +
      "FILE_NAME('Open CASCADE Shape Model','2026-09-07T14:17:22',(''),(''),'writer','','');\r\nENDSEC;\r\n";
    const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
    const original = encode(text);
    const nextSecond = encode(text.replace('14:17:22', '14:17:23'));
    expect(nextSecond).not.toEqual(original);
    expect(stepBytesForComparison(nextSecond)).toEqual(stepBytesForComparison(original));
    for (const changed of [text.replace('writer', 'Writer'), text.replace('ENDSEC', 'ENDSeC')]) {
      expect(stepBytesForComparison(encode(changed))).not.toEqual(stepBytesForComparison(original));
    }
    expect(() => stepBytesForComparison(encode(text.replace('14:17:22', '99:17:22')))).toThrow(/ISO 8601/);
    expect(() => stepBytesForComparison(encode(text.replace('14:17:22', 'not-time')))).toThrow(/ISO 8601/);
    expect(encode(text)).toEqual(original);
  });

  it('要件の 5 形式(STEP / STL / OBJ / glTF / 3MF 用の三角形)がすべて 1 本の口から出る', async () => {
    const key = 'api-export-all-formats';
    await buildPlate(key);
    const step = await api.exportShapes({ format: 'step', bodies: [exportItem(key)] });
    const stl = await api.exportShapes({
      format: 'stl',
      bodies: [exportItem(key)],
      deviationMm: 0.1,
    });
    const obj = await api.exportShapes({
      format: 'obj',
      bodies: [exportItem(key)],
      deviationMm: 0.1,
    });
    const gltf = await api.exportShapes({
      format: 'gltf',
      bodies: [exportItem(key)],
      deviationMm: 0.1,
    });
    // 3MF は `packages/io` が組むので、kernel が返すのは三角形まで(§0.a-0.19)。
    const threeMf = await api.exportShapes({
      format: 'mesh',
      bodies: [exportItem(key)],
      deviationMm: 0.1,
    });
    const brep = await api.exportShapes({ format: 'brep', bodies: [exportItem(key)] });

    expect([
      step.format,
      stl.format,
      obj.format,
      gltf.format,
      threeMf.format,
      brep.format,
    ]).toEqual(['step', 'stl', 'obj', 'gltf', 'mesh', 'brep']);
    // どの形式も中身が空でない(「出た」と言えることを 1 件ずつ確かめる)。
    if (
      step.format !== 'step' ||
      stl.format !== 'stl' ||
      obj.format !== 'obj' ||
      gltf.format !== 'gltf' ||
      threeMf.format !== 'mesh' ||
      brep.format !== 'brep'
    ) {
      return;
    }
    expect(step.bytes.length).toBeGreaterThan(0);
    expect(stl.files[0].bytes.length).toBeGreaterThan(0);
    expect(obj.files).toHaveLength(2);
    expect(gltf.files[0].bytes.length).toBeGreaterThan(0);
    expect(threeMf.bodies[0].triangles.triangleCount).toBe(12);
    expect(brep.bodies[0].bytes.length).toBeGreaterThan(0);
  });

  it('同じ品質なら STL・OBJ・glTF の三角形の枚数が 1 枚も違わない(§0.a-0.13)', async () => {
    const key = 'api-export-same-count';
    const built = await api.recomputeSolids({ steps: [cylinderStep(key)], generation: 1 });
    expect(built.failures).toEqual([]);

    const quality = { deviationMm: 0.1, angularDeflectionRad: 0.2 } as const;
    const stl = await api.exportShapes({ format: 'stl', bodies: [exportItem(key)], ...quality });
    const obj = await api.exportShapes({ format: 'obj', bodies: [exportItem(key)], ...quality });
    const gltf = await api.exportShapes({ format: 'gltf', bodies: [exportItem(key)], ...quality });

    if (stl.format !== 'stl' || obj.format !== 'obj' || gltf.format !== 'gltf') {
      return;
    }
    expect(stl.triangleCount).toBeGreaterThan(0);
    expect(obj.triangleCount).toBe(stl.triangleCount);
    expect(gltf.triangleCount).toBe(stl.triangleCount);
    expect(obj.droppedTriangleCount).toBe(stl.droppedTriangleCount);
    expect(gltf.droppedTriangleCount).toBe(stl.droppedTriangleCount);
  });

  it('角度の偏差を細かくすると丸い面の三角形が増える(品質は長さと角度の対)', async () => {
    const key = 'api-export-angular';
    const built = await api.recomputeSolids({ steps: [sphereStep(key)], generation: 1 });
    expect(built.failures).toEqual([]);

    // 長さの偏差は同じ 0.1mm のまま、角度だけを 0.5rad(画面と同じ既定)から 0.1rad へ。
    const coarse = await api.exportShapes({
      format: 'stl',
      bodies: [exportItem(key)],
      deviationMm: 0.1,
    });
    const fine = await api.exportShapes({
      format: 'stl',
      bodies: [exportItem(key)],
      deviationMm: 0.1,
      angularDeflectionRad: 0.1,
    });
    if (coarse.format !== 'stl' || fine.format !== 'stl') {
      return;
    }
    expect(fine.triangleCount).toBeGreaterThan(coarse.triangleCount);
    // 球の極には同じ節点を 2 度含む三角形ができる。落とした枚数を画面へ知らせられる。
    expect(coarse.droppedTriangleCount).toBeGreaterThan(0);
  });

  it('importShape({ format: "stl" }) は三角形の形として読み、単位は訊く扱いにする', async () => {
    const key = 'api-import-stl';
    await buildPlate(key);
    const written = await api.exportShapes({
      format: 'stl',
      bodies: [exportItem(key)],
      deviationMm: 0.1,
    });
    if (written.format !== 'stl') {
      return;
    }

    const read = await api.importShape({ format: 'stl', bytes: written.files[0].bytes });
    expect(read.bodies).toHaveLength(1);
    const body = read.bodies[0];
    // 三角形しか持たない形なので B-rep は作らない(§0.a-0.23)。型の枝も分かれている。
    expect(body.bodyKind).toBe('mesh');
    expect('brepBytes' in body).toBe(false);
    expect(body.triangles.triangleCount).toBe(12);
    expect(body.volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
    // **STL に単位は無い**ので `'other'`(取り込みの単位を訊くのは ui。§0.a-0.6)。
    expect(read.unit).toBe('other');
    expect(read.unitNames).toEqual([]);
  });

  it('importShape({ format: "obj" }) は OBJ を三角形の形として読む(単位は無い)', async () => {
    const key = 'api-import-obj';
    await buildPlate(key);
    const written = await api.exportShapes({
      format: 'obj',
      bodies: [exportItem(key)],
      deviationMm: 0.1,
    });
    if (written.format !== 'obj') {
      return;
    }

    const read = await api.importShape({ format: 'obj', bytes: written.files[0].bytes });
    const body = read.bodies[0];
    expect(body.bodyKind).toBe('mesh');
    expect(body.triangles.triangleCount).toBe(12);
    expect(body.volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 4);
    expect(read.unit).toBe('other');
  });

  it('importShape({ format: "gltf" }) は m で書いた .glb を mm へ戻す(FR-811)', async () => {
    const key = 'api-import-gltf';
    await buildPlate(key);
    const written = await api.exportShapes({
      format: 'gltf',
      bodies: [exportItem(key)],
      deviationMm: 0.1,
    });
    if (written.format !== 'gltf') {
      return;
    }

    const read = await api.importShape({ format: 'gltf', bytes: written.files[0].bytes });
    const body = read.bodies[0];
    expect(body.bodyKind).toBe('mesh');
    expect(body.triangles.triangleCount).toBe(12);
    // 書き出しは mm ÷ 1000(m)、読み込みは OCCT に 1000 倍させる。往復で mm に戻る。
    expect(body.volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 3);
    // 単位を取り違えようが無いので、利用者に訊かない(§0.a-0.6)。
    expect(read.unit).toBe('mm');
  });

  it('壊れたバイト列は STL / OBJ / glTF でも日本語の理由で断る(NFR-RE-1)', async () => {
    // STEP / B-rep の検査と同じ 8 バイト。STL の頭(84 バイト)にすら足りない。
    const broken = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const message =
      'このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。';
    await expect(api.importShape({ format: 'stl', bytes: broken })).rejects.toThrow(message);
    await expect(api.importShape({ format: 'gltf', bytes: broken })).rejects.toThrow(message);
    // OBJ は文字の並びとして読めてしまうので、形が入っていないほうの文言で断る。
    await expect(api.importShape({ format: 'obj', bytes: broken })).rejects.toThrow(
      'このファイルには形が入っていません。',
    );
  });

  it('頭の三角形の数が異常に大きい STL は「大きすぎます」で断る(§2.8 の断りの表)', async () => {
    // 中身が STL でない 200 バイト。頭の 4 バイトを uint32 として読むと 1 億を超えるので、
    // **500 万枚ぶんのバイト列を OCCT へ渡す前に**断れる(`readStl.ts` の門)。
    const garbage = new Uint8Array(200).fill(7);
    await expect(api.importShape({ format: 'stl', bytes: garbage })).rejects.toThrow(
      'この形は大きすぎて開けません(三角形が 117901063 個)。',
    );
  });

  it('三角形が 1 枚も無い STL は「面がありません」で断る(§2.8 の断りの表)', async () => {
    // 84 バイトちょうど(見出し 80 + 個数 0)の、仕様どおり正しい空の STL。
    const empty = new Uint8Array(84);
    await expect(api.importShape({ format: 'stl', bytes: empty })).rejects.toThrow(
      'この形には面がありません。',
    );
  });

  // ---------------------------------------------------------------------------
  // 3D プリント向けの点検(FR-815、NFR-PF-4、P6 §0.51・§2.16、タスク42)。
  //
  // ここは**配線だけ**を確かめる(段のキャッシュの鍵から立体を引けること、進捗・中止の
  // 口が Comlink 越しと同じ形で効くこと)。判定そのもの(最小肉厚・オーバーハング・
  // 水密性の中身)は `occt/inspectPrintability.test.ts` が実 OCCT でくわしく確かめ済み。
  // ---------------------------------------------------------------------------

  it('板 1 つの点検は水密・薄い三角形 0 で返る(FR-815)', async () => {
    await buildPlate('api-inspect-box');
    const result = await runInspectPrintability(api, {
      bodies: [exportItem('api-inspect-box')],
      deviationMm: 0.1,
    });

    expect(result.cancelled).toBe(false);
    expect(result.summary.watertight).toBe(true);
    expect(result.summary.thinCount).toBe(0);
    // 板は 40×30×10。最小肉厚のしきい値の既定(0.8mm)よりずっと厚い。
    expect(result.summary.minThicknessFoundMm).not.toBeNull();
    expect(result.summary.minThicknessFoundMm ?? 0).toBeGreaterThan(0.8);
  });

  it('ばねは実際の表示メッシュを同じ番号のまま点検する', async () => {
    const key = 'api-inspect-spring-mesh-identity';
    const built = await api.recomputeSolids({ steps: [springStep('ばね', key)], generation: 1 });
    expect(built.failures).toEqual([]);

    const inspected = await runInspectPrintability(api, {
      bodies: [exportItem(key)],
      deviationMm: 0.1,
      angularDeflectionRad: 0.5,
    });
    const displayTriangleCount = built.bodies[0].triangleCount;
    expect(displayTriangleCount).toBe(2066);
    expect(inspected.triangleCount).toBe(displayTriangleCount);
    expect(inspected.meshes).toHaveLength(1);
    expect(inspected.meshes[0].bodyKey).toBe(key);
    expect(inspected.meshes[0].meshRevision).toBeGreaterThan(0);
    expect(inspected.meshes[0].triangleCount).toBe(displayTriangleCount);
    // 判定の番号は表示メッシュの全三角形をちょうど覆い、別メッシュの番号へ出ない。
    expect(inspected.summary.inspectedTriangleCount).toBe(displayTriangleCount);
  });

  it('箱も実際の表示メッシュを点検し、再計算後は meshRevision が進む', async () => {
    const key = 'api-inspect-box-mesh-identity';
    const first = await api.recomputeSolids({
      steps: [extrudeStep('箱', key, 10)],
      generation: 1,
    });
    expect(first.failures).toEqual([]);
    const firstInspection = await runInspectPrintability(api, {
      bodies: [exportItem(key)],
      deviationMm: 0.02,
      angularDeflectionRad: 0.2,
    });
    expect(firstInspection.triangleCount).toBe(first.bodies[0].triangleCount);
    expect(firstInspection.meshes).toHaveLength(1);
    expect(firstInspection.meshes[0].bodyKey).toBe(key);
    expect(firstInspection.meshes[0].triangleCount).toBe(first.bodies[0].triangleCount);
    const firstRevision = firstInspection.meshes[0].meshRevision;

    const second = await api.recomputeSolids({
      steps: [extrudeStep('箱', key, 10)],
      generation: 2,
    });
    expect(second.cacheHits).toBe(1);
    const secondInspection = await runInspectPrintability(api, {
      bodies: [exportItem(key)],
      deviationMm: 0.5,
      angularDeflectionRad: 0.8,
    });
    expect(secondInspection.triangleCount).toBe(second.bodies[0].triangleCount);
    expect(secondInspection.meshes).toHaveLength(1);
    expect(secondInspection.meshes[0].bodyKey).toBe(key);
    expect(secondInspection.meshes[0].meshRevision).toBe(firstRevision + 1);
    expect(secondInspection.meshes[0].triangleCount).toBe(second.bodies[0].triangleCount);
  });

  it('shouldCancel が true を返すと、途中で打ち切って cancelled: true を返す(NFR-PF-4)', async () => {
    await buildPlate('api-inspect-cancel');
    const result = await runInspectPrintability(
      api,
      { bodies: [exportItem('api-inspect-cancel')], deviationMm: 0.1 },
      undefined,
      () => true,
    );

    expect(result.cancelled).toBe(true);
  });

  it('鍵が形状キャッシュに無い立体を点検しようとすると、日本語の理由で断る', async () => {
    await expect(
      runInspectPrintability(api, {
        bodies: [exportItem('api-inspect-missing')],
        deviationMm: 0.1,
      }),
    ).rejects.toThrow('もとになる立体が見つかりませんでした。もう一度計算し直してください。');
  });

  it('進捗の ratio は段が進むにつれて単調に増える(NFR-PF-4)', async () => {
    await buildPlate('api-inspect-progress');
    const progress: number[] = [];
    const result = await runInspectPrintability(
      api,
      { bodies: [exportItem('api-inspect-progress')], deviationMm: 0.1 },
      (value) => {
        progress.push(value.ratio);
      },
    );

    expect(result.cancelled).toBe(false);
    expect(progress.length).toBeGreaterThan(0);
    // 段の境目(例: watertight の終わり 0.1 と overhang の始まり 0.1)は、
    // `PHASE_WEIGHTS` の式を通る側と定数のまま返る側とで浮動小数の丸めが 1 ビットだけ
    // 食い違うことがある(実測: 0.1 と 0.10000000000000002)。「単調に増える」の主張は
    // 段の中の傾向であって最終ビットの一致ではないので、極小の許容を入れて比べる。
    const MONOTONIC_EPSILON = 1e-9;
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1] - MONOTONIC_EPSILON);
    }
    expect(progress[progress.length - 1]).toBeCloseTo(1, 6);
  });
});

describe('owned runSolidRecompute call envelope metadata', () => {
  function measuredPhaseCache() {
    return createShapeCache<CachedSolid>(16,
      entry => entry.mesh.positions.byteLength + entry.mesh.normals.byteLength + entry.mesh.indices.byteLength + entry.mesh.edgePositions.byteLength,
      entry => [entry.mesh.positions.buffer, entry.mesh.normals.buffer, entry.mesh.indices.buffer, entry.mesh.edgePositions.buffer]);
  }
  async function completePhaseCleanup(actions: readonly (() => void | Promise<void>)[], bodyFailed: boolean, bodyFailure: unknown) {
    const failures: unknown[] = [];
    for (const action of actions) { try { await action(); } catch (error) { failures.push(error); } }
    if (failures.length > 0) throw new AggregateError(bodyFailed ? [bodyFailure, ...failures] : failures, 'Actual native phase cleanup failed');
  }
  it('bounds primitive records and retains loss, missing owner, conflicts and discontinuous clocks', () => {
    let time = 100;
    const observer = createKernelPhaseObserver(() => ({ epochMs: time, monoMs: time }));
    const owner = { dispatchId: 'observer-only', partId: 'part', generation: 1, kind: 'display' as const, steps: [] };
    observer.record('native-build-start', undefined);
    observer.record('native-build-return', owner);
    observer.record('native-build-return', { ...owner, generation: 2 });
    time = 50;
    observer.record('native-build-return', owner);
    for (let index = 0; index < 257; index += 1) observer.record('reply-preclone', owner);
    const snapshot = observer.snapshot();
    expect(snapshot.records).toHaveLength(256); expect(snapshot.lastSeq).toBe(261); expect(snapshot.dropped).toBe(5);
    expect(snapshot.missingOwners).toBe(1); expect(snapshot.ownerConflicts).toBeGreaterThan(0);
    expect(snapshot.clockDiscontinuities).toBe(1);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(snapshot.records.every(record => Object.isFrozen(record) && !('steps' in record) && !('body' in record))).toBe(true);
    expect(snapshot.coverage).toBe('runSolidRecompute-call-plus-admission-preclone');
    expect(snapshot.unobserved).toContain('internal-native-subcalls'); expect(snapshot.unobserved).toContain('physical-resident');
    const failed = createKernelPhaseObserver(() => { throw new Error('diagnostic clock unavailable'); });
    expect(() => failed.record('native-build-start', owner)).not.toThrow();
    expect(failed.snapshot()).toMatchObject({ clockDiscontinuities: 1, records: [{ epochMs: null, monoMs: null }] });
  });
  it.each(['sync-false', 'async-false', 'sync-true', 'async-true', 'sync-throw', 'async-throw'] as const)(
    'observes actual %s cancellation without an extra token invocation or detaching an old borrower', async mode => {
      const cache = measuredPhaseCache(), api = createKernelApi(loadOcctForNode, cache);
      const firstSteps = [extrudeStep('phase-old', 'phase-old', 10)];
      const firstOwner = { dispatchId: 'phase-first', partId: 'phase-part', generation: 1, kind: 'display' as const,
        steps: firstSteps.map(step => ({ id: step.id, key: step.key })) };
      const steps = [extrudeStep('phase-a', 'phase-a', 11), extrudeStep('phase-b', 'phase-b', 12)];
      const owner = { dispatchId: 'phase-next', partId: 'phase-part', generation: 2, kind: 'display' as const,
        steps: steps.map(step => ({ id: step.id, key: step.key })) };
      let checks = 0, bodyFailed = false;
      let bodyFailure: unknown;
      expect(cache.meshBufferSnapshot?.().status).toBe('known');
      const cancel = () => {
        checks += 1;
        if (mode === 'sync-throw') throw new Error('actual cancel failure');
        if (mode === 'async-throw') return Promise.reject(new Error('actual cancel failure'));
        const value = mode === 'sync-true' || mode === 'async-true';
        return mode.startsWith('async') ? Promise.resolve(value) : value;
      };
      try {
        const first = await api.recomputeSolids({ partId: 'phase-part', generation: 1, steps: firstSteps }, {}, undefined,
          undefined, firstOwner, () => true);
        const borrower = first.bodies[0]?.positions;
        if (borrower === undefined || borrower.byteLength === 0) throw new Error('Actual native first mesh required');
        const originalBuffer = borrower.buffer, originalBytes = borrower.byteLength;
        await api.acknowledgeMeshReply?.(firstOwner);
        const pending = api.recomputeSolids({ partId: 'phase-part', generation: 2, steps }, {}, undefined, cancel, owner, () => true);
        if (mode.endsWith('throw')) await expect(pending).rejects.toThrow('actual cancel failure');
        else {
          const result = await pending;
          expect(result.cancelled).toBe(mode.endsWith('true'));
          expect(result.bodies).toHaveLength(mode.endsWith('true') ? 0 : 2);
        }
        expect(checks).toBe(mode.endsWith('false') ? 2 : 1);
        if (api.readRuntimePhases === undefined) throw new Error('Actual phase observer required');
        const snapshot = await api.readRuntimePhases();
        const records = snapshot.records.filter(record => record.dispatchId === owner.dispatchId);
        expect(records.filter(record => record.phase === 'geometry-cancel-check')).toHaveLength(checks);
        expect(records.filter(record => record.phase === 'geometry-cancel-request')).toHaveLength(mode.endsWith('true') ? 1 : 0);
        expect(records.filter(record => record.phase === 'geometry-cancel-check-throw')).toHaveLength(mode.endsWith('throw') ? 1 : 0);
        expect(records.some(record => record.phase === (mode.endsWith('throw') ? 'native-build-throw'
          : mode.endsWith('true') ? 'native-build-cancelled' : 'native-build-return'))).toBe(true);
        expect(borrower.buffer).toBe(originalBuffer); expect(borrower.byteLength).toBe(originalBytes);
        expect(snapshot.unobserved).toContain('physical-resident');
      } catch (error) { bodyFailed = true; bodyFailure = error; throw error; }
      finally {
        await completePhaseCleanup([
          async () => { await api.acknowledgeMeshReply?.(owner); },
          async () => { await api.acknowledgeMeshReply?.(firstOwner); },
          () => api.releasePart('phase-part'), () => cache.clear(),
        ], bodyFailed, bodyFailure);
      }
    },
  );
  it('keeps rejected actual owner and preclone admission distinct from successful reply publication', async () => {
    const api = createKernelApi(loadOcctForNode), steps = [extrudeStep('admission', 'admission', 10)];
    const owner = { dispatchId: 'admission-owner', partId: 'phase-admission', generation: 1, kind: 'display' as const,
      steps: steps.map(step => ({ id: step.id, key: step.key })) };
    try {
      await expect(api.recomputeSolids({ partId: owner.partId, generation: 2, steps }, {}, undefined, undefined, owner, () => true))
        .rejects.toThrow('Dispatch mesh owner mismatch');
      await expect(api.recomputeSolids({ partId: owner.partId, generation: 1, steps }, {}, undefined, undefined, owner, () => false))
        .rejects.toThrow('Global pre-clone mesh reply admission refused');
      if (api.readRuntimePhases === undefined) throw new Error('Actual phase observer required');
      const snapshot = await api.readRuntimePhases();
      expect(snapshot.records.filter(record => record.phase === 'owner-rejected')).toHaveLength(1);
      expect(snapshot.records.filter(record => record.phase === 'reply-admission-rejected')).toHaveLength(1);
      expect(snapshot.records.filter(record => record.phase === 'reply-preclone')).toEqual([]);
    } finally { await api.acknowledgeMeshReply?.(owner); await api.releasePart(owner.partId); }
  });
});

describe('EX12 current mesh accounting: records follow the capacity (1,000 distinct parts)', () => {
  const CAPACITY = 512 * 1024 * 1024;
  const BUDGET = { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 };
  const ownerOf = (index: number) => ({ dispatchId: `ex12-display-${String(index)}`, partId: `ex12-part-${String(index)}`,
    generation: 1, kind: 'display' as const, steps: [] });
  /** Empty managed recomputes rotate real display ownership without OCCT (one current owner per distinct part). */
  async function holdParts(target: ReturnType<typeof createKernelApi>, count: number): Promise<ReturnType<typeof ownerOf>[]> {
    const owners: ReturnType<typeof ownerOf>[] = [];
    for (let index = 0; index < count; index += 1) {
      const owner = ownerOf(index);
      await target.recomputeSolids({ partId: owner.partId, generation: owner.generation, steps: [], localMesh: BUDGET },
        {}, undefined, undefined, owner, () => true);
      expect(await target.acknowledgeMeshReply?.(owner)).toEqual({ acknowledged: true });
      owners.push(owner);
    }
    return owners;
  }

  it('one reading of the 512 MiB capacity enumerates 1,000 display parts and expected owners (the fixed 128 refused them)', async () => {
    const target = createKernelApi(() => Promise.reject(new Error('Empty work must not load OCCT')));
    const owners = await holdParts(target, 1_000);
    try {
      const reading = await target.readCurrentMeshAccounting?.({ observationId: 'ex12-1000', limitBytes: CAPACITY, expectedOwners: owners });
      if (reading?.status !== 'known') throw new Error(`Known 1,000-part reading: ${reading?.status === 'unknown' ? reading.reason : 'missing'}`);
      expect(reading.owners).toHaveLength(1_000);
      expect(reading.owners.map(owner => owner.partId)).toEqual(owners.map(owner => owner.partId));
    } finally { for (const owner of owners) await target.releasePart(owner.partId); }
  });

  it('the record bound is one per 4 KiB of the reading capacity: refused with its reason above it, read again below it', async () => {
    const target = createKernelApi(() => Promise.reject(new Error('Empty work must not load OCCT')));
    const owners = await holdParts(target, 130);
    const limitBytes = 129 * 4096; // 129 records of capacity.
    try {
      expect(await target.readCurrentMeshAccounting?.({ observationId: 'ex12-parts-over', limitBytes, expectedOwners: [] }))
        .toEqual({ status: 'unknown', observationId: 'ex12-parts-over', reason: 'metadata-capacity' });
      await target.releasePart(owners[129]?.partId ?? '');
      expect(await target.readCurrentMeshAccounting?.({ observationId: 'ex12-parts-below', limitBytes, expectedOwners: owners.slice(0, 129) }))
        .toMatchObject({ status: 'known', observationId: 'ex12-parts-below' });
      expect(await target.readCurrentMeshAccounting?.({ observationId: 'ex12-owners-over', limitBytes, expectedOwners: owners }))
        .toEqual({ status: 'unknown', observationId: 'ex12-owners-over', reason: 'metadata-capacity' });
      expect(await target.readCurrentMeshAccounting?.({ observationId: 'ex12-full-capacity', limitBytes: CAPACITY, expectedOwners: owners.slice(0, 129) }))
        .toMatchObject({ status: 'known' });
    } finally { for (const owner of owners) await target.releasePart(owner.partId); }
  });
});
