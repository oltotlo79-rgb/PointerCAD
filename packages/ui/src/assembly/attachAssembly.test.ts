import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument,
  embedPart, emptyEmbeddedPartAttachments, EMPTY_PART_LIBRARY, KERNEL_BROKEN_MESSAGE,
  applyPlacementToDirection, moveComponent, quaternionFromAxisAngle, removeComponent, resolvePart,
  type AssemblyDocument, type AssemblyKernelBridge, type Mate, type PartDocument, type SolidBody, type Vec3,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { createFakeRecompute } from '../store/testing/createTestStore.js';
import { attachAssembly } from './attachAssembly.js';
import { addMateTarget, commitMateDraft, startMate, updateMateSource } from './mateActions.js';
import { subShapeRefOf } from '../solid/subShapeSelection.js';
import { assemblyMateStatus } from '../shell/statusText.js';

beforeEach(resetTestStore);

function importedPart(): PartDocument {
  return { ...createEmptyPartDocument(), solids: [{ id: 'imported-1', name: 'STEP',
    kind: 'importedSolid', suppressed: false, shapeRef: 'shape-1', bodyKind: 'solid',
    source: { format: 'step', fileName: 'source.step', unit: 'mm', byteLength: 1 } }] };
}

async function fixture() {
  const a = await embedPart(EMPTY_PART_LIBRARY, importedPart(), 'a.pcad', 'a.pcad', {
    attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', Uint8Array.of(10)]]) },
  });
  const b = await embedPart(a.library, importedPart(), 'b.pcad', 'b.pcad', {
    attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', Uint8Array.of(20)]]) },
  });
  let document = createAssemblyDocument('assembly');
  for (const partRef of [a.partRef, b.partRef, a.partRef]) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }));
  }
  return { document, library: b.library, a: a.partRef, b: b.partRef };
}

function body(featureId: string, size: number): SolidBody {
  const box = new THREE.BoxGeometry(size, size, size);
  box.translate(size / 2, size / 2, size / 2);
  const edges = new THREE.EdgesGeometry(box);
  const directions: readonly Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  try {
    const indices = box.getIndex();
    if (indices === null) throw new Error('fixture');
    return { featureId, volume: size ** 3, isValid: true, edges: [], vertices: [], threadMarks: [],
      faces: directions.map((axis, index) => ({ index, surfaceKind: 'plane', area: size * size,
        centroid: [(axis[0] + 1) * size / 2, (axis[1] + 1) * size / 2, (axis[2] + 1) * size / 2],
        axis, radius: null, triangleOffset: index * 2, triangleCount: 2 })),
      mesh: { positions: new Float32Array(box.getAttribute('position').array), normals: new Float32Array(box.getAttribute('normal').array),
        indices: new Uint32Array(indices.array), edgePositions: new Float32Array(edges.getAttribute('position').array), triangleCount: 12 } };
  } finally { edges.dispose(); box.dispose(); }
}

function fakeBridge() {
  const keys = new Set<string>();
  const releasePart = vi.fn<AssemblyKernelBridge['releasePart']>(() => Promise.resolve());
  const checkShapeAvailability = vi.fn<AssemblyKernelBridge['checkShapeAvailability']>((partId, requested) =>
    Promise.resolve({ partId, missingKeys: requested.filter((key) => !keys.has(key)) }));
  const recomputeSolids = vi.fn<AssemblyKernelBridge['recomputeSolids']>((steps) => {
    for (const step of steps) keys.add(step.key);
    return Promise.resolve({ bodies: steps.filter((step) => step.visible).map((step) =>
      body(step.featureId, step.plan.kind === 'importedSolid' ? step.plan.bytes[0] : 1)),
    failures: [], cacheHits: 0, cancelled: false });
  });
  const bridge: AssemblyKernelBridge = {
    releasePart, checkShapeAvailability, recomputeSolids,
    tessellateSketchFaces: () => Promise.resolve({ mesh: { faces: [] }, failures: [] }),
    offsetSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    projectSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    sectionSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    measure: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    exportShapes: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    importShape: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    inspectPrintability: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    dispose: () => undefined,
  };
  return { bridge, keys, recomputeSolids, releasePart, checkShapeAvailability };
}

async function settle(): Promise<void> {
  await vi.waitFor(() => {
    const state = useAppStore.getState();
    expect(state.isComputing).toBe(false);
    expect(state.completedGeneration).toBe(state.requestedGeneration);
  });
}

function originMate(document: AssemblyDocument, kind: 'coincident' | 'distance', value?: number): Mate {
  return {
    id: 'mate-1', name: '合致1', kind,
    a: { kind: 'origin', componentId: document.components[0].id, element: 'origin' },
    b: { kind: 'origin', componentId: document.components[1].id, element: 'origin' },
    ...(value === undefined ? {} : { value: { ...expressionValueFromNumber(value),
      source: value === 20 ? '10*2' : String(value), display: value === 20 ? '10*2' : String(value) } }),
    flipped: false, suppressed: false,
  };
}

describe('アセンブリの実経路', () => {
  it.each([0, 5, -5])('実部分形状と実solverで20mm箱の面offset %sを解き、Undo/Redoも解き直す', async (offset) => {
    const f = await fixture();
    let document = createAssemblyDocument('箱');
    for (let index = 0; index < 2; index += 1) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: f.b }));
    document = moveComponent(document, 'component-2', { position: [expressionValueFromNumber(0), expressionValueFromNumber(0), expressionValueFromNumber(50)], rotation: [0, 0, 0, 1] });
    useAppStore.getState().openAssembly(document, f.library);
    const bridge = fakeBridge();
    const detach = attachAssembly(bridge.bridge);
    try {
      await settle(); startMate('coincident');
      for (const [componentId, index] of [['component-1', 4], ['component-2', 5]] as const) {
        const ref = subShapeRefOf([body('imported-1', 20)], `imported-1#face:${index}`);
        if (ref === null) throw new Error('fixture');
        expect(addMateTarget({ kind: 'subShape', componentId, ref })).toBe(true);
      }
      updateMateSource(String(offset));
      expect(commitMateDraft()?.ok).toBe(true); await settle();
      const check = () => {
        const state = useAppStore.getState();
        expect(state.assemblyView?.diagnosis?.converged, JSON.stringify({ diagnosis: state.assemblyView?.diagnosis, mates: state.assembly?.mates })).toBe(true);
        expect(state.assemblyView?.resolved.placements.get('component-2')?.position[2]).toBeCloseTo(20 + offset, 9);
        expect(state.assemblyView?.resolved.placements.get('component-1')?.position).toEqual([0, 0, 0]);
        expect(state.assembly?.components[1].placement.position[2].value).toBe(50);
      };
      check(); expect(bridge.recomputeSolids).toHaveBeenCalledTimes(1);
      useAppStore.getState().undo(); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-2')?.position[2]).toBe(50);
      useAppStore.getState().redo(); await settle(); check();
      const stable = useAppStore.getState().assemblyView?.resolved.placements.get('component-2');
      useAppStore.setState((state) => ({ documentVersion: state.documentVersion + 1 })); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-2')).toEqual(stable);
    } finally { detach(); }
  });

  it.each([4, 5])('初期の面index=%sでも実solverの既定が向かい合わせになる', async (faceIndex) => {
    const f = await fixture();
    let document = createAssemblyDocument('箱');
    for (let i = 0; i < 2; i += 1) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: f.b }));
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle();
      for (const [componentId, index] of [['component-1', 4], ['component-2', faceIndex]] as const) {
        const ref = subShapeRefOf([body('imported-1', 20)], `imported-1#face:${index}`);
        if (ref === null) throw new Error('fixture');
        addMateTarget({ kind: 'subShape', componentId, ref });
      }
      expect(useAppStore.getState().assemblyMateDraft?.flipped).toBe(faceIndex === 4);
      commitMateDraft(); await settle();
      const placement = useAppStore.getState().assemblyView?.resolved.placements.get('component-2');
      if (placement === undefined) throw new Error('placement');
      expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(true);
      const direction = applyPlacementToDirection(placement, [0, 0, faceIndex === 4 ? 1 : -1]);
      expect(direction[2]).toBeCloseTo(-1, 9);
    } finally { detach(); }
  });

  it('角度の90度既定を45度の基準軸から実solverで解く', async () => {
    const f = await fixture();
    const document = moveComponent(f.document, 'component-2', { ...f.document.components[1].placement,
      rotation: quaternionFromAxisAngle([0, 0, 1], Math.PI / 4) });
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle(); startMate('angle');
      for (const componentId of ['component-1', 'component-2']) addMateTarget({ kind: 'origin', componentId, element: 'x' });
      expect(commitMateDraft()).toMatchObject({ ok: true, mate: { value: { value: 90 } } });
      await settle();
      const placement = useAppStore.getState().assemblyView?.resolved.placements.get('component-2');
      if (placement === undefined) throw new Error('placement');
      expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(true);
      expect(applyPlacementToDirection(placement, [1, 0, 0])[0]).toBeCloseTo(0, 9);
    } finally { detach(); }
  });

  it('平行軸から90度の零微分は実solverの停止理由を示し、last-goodを保つ', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle();
      const before = useAppStore.getState().assemblyView?.resolved.placements.get('component-2');
      startMate('angle');
      for (const componentId of ['component-1', 'component-2']) addMateTarget({ kind: 'origin', componentId, element: 'x' });
      expect(commitMateDraft()?.ok).toBe(true);
      await settle();
      const view = useAppStore.getState().assemblyView;
      expect(view?.diagnosis?.status).toBe('stalled');
      expect(view?.diagnosis?.provenConflictMateIds).toEqual([]);
      expect(view?.resolved.placements.get('component-2')).toEqual(before);
      expect(assemblyMateStatus(null, view?.diagnosis ?? null, new Map())?.text).toContain('計算が進まなく');
      expect(useAppStore.getState().lastOutcome).toBe('failed');
    } finally { detach(); }
  });

  it('独立成分の部分成功を採用し、失敗成分だけ保持して修正後に更新する', async () => {
    const f = await fixture();
    let document = createAssemblyDocument('独立した組');
    for (let i = 0; i < 4; i += 1) {
      const component = createComponentFor(document, { kind: 'part', partRef: f.b });
      document = addComponent(document, component);
      document = moveComponent(document, component.id, { position: [expressionValueFromNumber(i * 12), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1] });
    }
    const origin = (componentId: string) => ({ kind: 'origin', componentId, element: 'origin' } as const);
    const distance = (id: string, value: number): Mate => ({ id, name: id, kind: 'distance', a: origin('component-3'), b: origin('component-4'), flipped: false, suppressed: false, value: expressionValueFromNumber(value) });
    const mates = [originMate(document, 'coincident'), distance('mate-2', 10), distance('mate-3', 20)];
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle(); useAppStore.getState().applyAssembly({ ...document, mates }); await settle();
      expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(false);
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-2')?.position[0]).toBeCloseTo(0, 9);
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-4')?.position[0]).toBe(36);
      const movedFixed = moveComponent({ ...document, mates }, 'component-1', { position: [expressionValueFromNumber(100), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1] });
      useAppStore.getState().applyAssembly(movedFixed); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-1')?.position[0]).toBe(100);
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-2')?.position[0]).toBeCloseTo(100, 9);
      useAppStore.getState().applyAssembly({ ...document, mates: mates.slice(0, 2) }); await settle();
      expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(true);
      const placements = useAppStore.getState().assemblyView?.resolved.placements;
      expect(Math.abs((placements?.get('component-4')?.position[0] ?? 0) - (placements?.get('component-3')?.position[0] ?? 0))).toBeCloseTo(10, 9);
      // 削除要求の計算が上書きされても、再追加された同じIDへ過去の解を戻さない。
      useAppStore.getState().applyAssembly(removeComponent({ ...document, mates: mates.slice(0, 2) }, 'component-4'));
      useAppStore.getState().applyAssembly({ ...document, mates }); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-4')?.position[0]).toBe(36);
      // 同じIDでも別文書の初回失敗は前の成功姿勢を引き継がない。
      useAppStore.getState().closeAssembly();
      useAppStore.getState().openAssembly({ ...document, mates }, f.library); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-4')?.position[0]).toBe(36);
    } finally { detach(); }
  });

  it('既に消失した面を追加しても確定前に拒否し、文書と履歴を変えない', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle(); startMate('coincident');
      const ref = subShapeRefOf([body('gone', 20)], 'gone#face:4');
      if (ref === null) throw new Error('fixture');
      expect(addMateTarget({ kind: 'subShape', componentId: 'component-1', ref })).toBe(false);
      expect(useAppStore.getState().assemblyMateDraft?.issue).toBeTruthy();
      const before = useAppStore.getState();
      expect(commitMateDraft()?.ok).toBe(false);
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    } finally { detach(); }
  });
  it('原点一致を実solveMatesで解き、解だけをAssemblyViewへ置く', async () => {
    const f = await fixture();
    const moved = moveComponent(f.document, f.document.components[1].id, {
      position: [expressionValueFromNumber(12), expressionValueFromNumber(0), expressionValueFromNumber(0)],
      rotation: [0, 0, 0, 1],
    });
    const document = { ...moved, mates: [originMate(moved, 'coincident')] };
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    await settle();
    expect(useAppStore.getState().assemblyView?.resolved.placements.get(document.components[1].id)?.position[0]).toBeCloseTo(0, 9);
    expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(true);
    expect(useAppStore.getState().assembly?.components[1].placement.position[0].value).toBe(12);
    detach();
  });

  it('距離式10*2を実solverで20mmへ解き、式は文書へ残す', async () => {
    const f = await fixture();
    const moved = moveComponent(f.document, f.document.components[1].id, {
      position: [expressionValueFromNumber(5), expressionValueFromNumber(0), expressionValueFromNumber(0)],
      rotation: [0, 0, 0, 1],
    });
    const document = { ...moved, mates: [originMate(moved, 'distance', 20)] };
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    await settle();
    const position = useAppStore.getState().assemblyView?.resolved.placements.get(document.components[1].id)?.position;
    expect(Math.abs(position?.[0] ?? 0)).toBeCloseTo(20, 9);
    expect(useAppStore.getState().assembly?.mates[0].value).toMatchObject({ source: '10*2', value: 20 });
    detach();
  });

  it('合致だけの変更は部品形を再計算せず、実診断を更新する', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    useAppStore.getState().applyAssembly({ ...f.document, mates: [originMate(f.document, 'coincident')] });
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().assemblyView?.diagnosis).not.toBeNull();
    detach();
  });

  it('対象が欠けた合致を消さず、理由とDOF不明を返す', async () => {
    const f = await fixture();
    const mate = { ...originMate(f.document, 'coincident'),
      b: { kind: 'origin', componentId: 'missing', element: 'origin' } as const };
    const document = { ...f.document, mates: [mate] };
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    await settle();
    expect(useAppStore.getState().assemblyView?.mateTargetErrors.get('mate-1')).toHaveLength(1);
    expect(useAppStore.getState().assembly?.mates).toHaveLength(1);
    expect(useAppStore.getState().assemblyView?.diagnosis?.complete).toBe(false);
    detach();
  });
  it('別 STEP 2 種・同一部品 2 個を1つの橋で解決し、鍵と寸法が混ざらない', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(fake.recomputeSolids.mock.calls.map((call) => call[1]?.partId)).toEqual([f.a, f.b]);
    expect(fake.recomputeSolids.mock.calls[0][0][0].key).not.toBe(fake.recomputeSolids.mock.calls[1][0][0].key);
    const view = useAppStore.getState().assemblyView;
    expect(view?.bodies.get(f.a)?.[0].volume).toBe(1000);
    expect(view?.bodies.get(f.b)?.[0].volume).toBe(8000);
    expect(view?.resolved.partKeys.size).toBe(3);
    detach();
  });

  it('配置変更は形の参照を保ち、部品を再計算しない', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    const previous = useAppStore.getState().assemblyView?.bodies.get(f.a);
    const previousAppearance = useAppStore.getState().assemblyView?.appearances.get(f.a);
    useAppStore.getState().applyAssembly(moveComponent(f.document, f.document.components[0].id, {
      position: [expressionValueFromNumber(30), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1],
    }));
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().assemblyView?.bodies.get(f.a)).toBe(previous);
    expect(useAppStore.getState().assemblyView?.appearances.get(f.a)).toBe(previousAppearance);
    expect(useAppStore.getState().assemblyView?.resolved.placements.get(f.document.components[0].id)?.position).toEqual([30, 0, 0]);
    detach();
  });

  it('構造化された欠落があれば、その部品だけ再取得する', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    fake.keys.delete(fake.recomputeSolids.mock.calls[0][0][0].key);
    useAppStore.getState().applyAssembly({ ...f.document, name: 'changed' });
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(3);
    expect(fake.recomputeSolids.mock.calls[2][1]?.partId).toBe(f.a);
    expect(useAppStore.getState().lastOutcome).toBe('success');
    detach();
  });

  it('取り直しても欠ける形は無限に再試行しない', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    fake.checkShapeAvailability.mockImplementation((partId, keys) => Promise.resolve({ partId, missingKeys: keys }));
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().lastOutcome).toBe('failed');
    expect(useAppStore.getState().assemblyView?.bodies.size).toBe(0);
    detach();
  });

  it('最後のインスタンスが消えた部品だけ releasePart する', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    useAppStore.getState().applyAssembly(removeComponent(f.document, f.document.components[1].id));
    await settle();
    expect(fake.releasePart).toHaveBeenCalledExactlyOnceWith(f.b);
    detach();
    await vi.waitFor(() => expect(fake.releasePart).toHaveBeenCalledWith(f.a));
  });

  it('遅れて届いた古い世代を適用せず、最新だけを適用する', async () => {
    const library = (await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'a.pcad', '')).library;
    let document = createAssemblyDocument('assembly');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'part-1' }));
    useAppStore.getState().openAssembly(document, library);
    const fake = createFakeRecompute();
    const detach = attachAssembly(fakeBridge().bridge, fake.recompute);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    useAppStore.getState().applyAssembly({ ...document, name: 'latest' });
    expect(fake.calls[0].options.shouldCancel?.()).toBe(true);
    fake.calls[0].options.onResolved?.(resolvePart(fake.calls[0].document));
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(useAppStore.getState().assemblyView).toBeNull();
    fake.calls[1].options.onResolved?.(resolvePart(fake.calls[1].document));
    fake.calls[1].settle(resultFor(fake.calls[1].document));
    await settle();
    expect(useAppStore.getState().completedGeneration).toBe(useAppStore.getState().requestedGeneration);
    detach();
  });

  it('Worker の失敗は完了として知らせ、待ち続けない', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const fake = fakeBridge();
    fake.recomputeSolids.mockRejectedValue(new Error(KERNEL_BROKEN_MESSAGE));
    const detach = attachAssembly(fake.bridge);
    await settle();
    expect(useAppStore.getState().lastOutcome).toBe('workerBroken');
    expect(useAppStore.getState().completedGeneration).toBe(useAppStore.getState().requestedGeneration);
    detach();
  });

  it('部品画面では assembly の再計算を呼ばない', () => {
    const fake = fakeBridge();
    const detach = attachAssembly(fake.bridge);
    expect(fake.recomputeSolids).not.toHaveBeenCalled();
    detach();
  });
});
