import { appearanceFromPreset, createSubShapeReference, type PartDocument, type SolidBody, type SubShapeOrigin, type SubShapeRef } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { holeFeature, resetTestStore } from '../store/testing/createTestStore.js';
import { beginReferenceRepair, cancelReferenceRepair, commitReferenceRepair, referenceRepairImpacts } from './referenceRepair.js';
import { repairCandidates, repairResolution } from './referenceRepairCandidates.js';
import { currentRepairSlots } from './referenceRepairContext.js';
import { repairFixture } from './referenceRepairFixture.js';
import { summarizeRepairReference } from './referenceRepairSummary.js';

const origin = (role: 'top' | 'bottom' | 'right'): SubShapeOrigin => ({ version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'base', role } });
it('開いた輪郭の保存線を表示し参照を変更しない', () => {
  const reference: SubShapeRef = { bodyFeatureId: 'surface', index: 2,
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'surface-side', featureId: 'surface',
      profile: { sketchId: 'saved-sketch', lineFeatureId: 'saved-line', role: 'whole-line' } } },
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 200, position: [10, 0, 5], axis: [0, -1, 0], radius: null } };
  const before = structuredClone(reference);
  expect(summarizeRepairReference(reference)).toBe('開いた輪郭を掃いた面  / saved-sketch / saved-line / surface / 面 2 / (10, 0, 5) mm / 面積 200 mm²');
  expect(reference).toEqual(before);
});
function setup(swapped: boolean) {
  const fixture = repairFixture(), first = swapped ? 1 : 0, second = swapped ? 0 : 1;
  const body: SolidBody = { ...fixture.body, faces: [
    { index: first, surfaceKind: 'plane', area: 100, centroid: [0, 0, 10], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1 },
    { index: second, surfaceKind: 'plane', area: 100, centroid: [0, 0, 0], axis: [0, 0, -1], radius: null, triangleOffset: 1, triangleCount: 1 },
  ], origins: { version: 1, state: 'tracked', bindings: [
    { origin: origin('top'), state: 'unique', current: { kind: 'face', index: first } },
    { origin: origin('bottom'), state: 'unique', current: { kind: 'face', index: second } },
    { origin: origin('right'), state: 'missing', reason: 'deleted' },
  ] } };
  const hole = holeFeature('hole', 'base');
  const reference: SubShapeRef = { ...hole.face, origin: origin('right') };
  const document = { ...fixture.document, solids: [fixture.document.solids[0], { ...hole, face: reference }],
    appearance: { entries: [{ id: 'surface-color', target: { kind: 'face' as const, ref: reference }, appearance: appearanceFromPreset('steel') }] },
    selectionSets: [{ id: 'selection-set', name: '検査面', members: [{ kind: 'face' as const, ref: reference }] }],
    references: [{ id: 'center', name: '面中心', kind: 'referencePoint' as const, visible: true, suppressed: false,
      definition: { kind: 'faceCenter' as const, face: reference } }],
  };
  useAppStore.getState().applyDocument(document);
  useAppStore.setState({ bodies: [body], completedGeneration: 1, requestedGeneration: 1,
    isComputing: false, recomputeCancelled: false, timelineIndex: null, lastOutcome: 'success' });
  const slot = currentRepairSlots(useAppStore.getState()).find(slot => slot.ownerId === 'hole');
  if (slot === undefined) throw new Error('穴の参照が必要');
  return { body, slot, reference, first };
}
beforeEach(resetTestStore);
afterEach(resetTestStore);

describe('番号交換と意味参照', () => {
  it.each([['side', '側面'], ['start', '始点側'], ['end', '終点側']] as const)('円錐の%sを翻訳し現在の幾何情報を保つ', (role, label) => {
    const reference: SubShapeRef = { bodyFeatureId: 'cone-1', index: 3,
      origin: { version: 1, shapeKind: 'face', identity: { kind: 'cone-face', featureId: 'cone-1', role } },
      fingerprint: { kind: 'face', surfaceKind: role === 'side' ? 'cone' : 'plane', area: 250,
        position: [1, 2, 3], axis: [0, 0, 1], radius: role === 'side' ? 5 : null },
    };
    const before = structuredClone(reference);
    expect(summarizeRepairReference(reference)).toBe(`円錐の面 ${label} / cone-1 / 面 3 / (1, 2, 3) mm / 面積 250 mm²`);
    expect(reference).toEqual(before);
  });
  it('トーラスの曲面を翻訳し現在の幾何情報を保つ', () => {
    const reference: SubShapeRef = { bodyFeatureId: 'torus-1', index: 2,
      origin: { version: 1, shapeKind: 'face', identity: { kind: 'torus-face', featureId: 'torus-1', role: 'surface' } },
      fingerprint: { kind: 'face', surfaceKind: 'torus', area: 600,
        position: [4, 5, 6], axis: [0, 0, 1], radius: null },
    };
    const before = structuredClone(reference);
    expect(summarizeRepairReference(reference)).toBe('トーラスの面 曲面 / torus-1 / 面 2 / (4, 5, 6) mm / 面積 600 mm²');
    expect(reference).toEqual(before);
  });
  it('球面の意味を日本語で示し現在の幾何情報と参照を保持する', () => {
    const reference: SubShapeRef = { bodyFeatureId: 'sphere-1', index: 7,
      origin: { version: 1, shapeKind: 'face', identity: {
        kind: 'sphere-face', featureId: 'sphere-1', role: 'surface',
      } },
      fingerprint: { kind: 'face', surfaceKind: 'sphere', area: 1256,
        position: [10, 20, 30], axis: null, radius: 10 },
    };
    const before = structuredClone(reference);
    const summary = summarizeRepairReference(reference);
    expect(summary).toBe('球の面 曲面 / sphere-1 / 面 7 / (10, 20, 30) mm / 面積 1256 mm²');
    expect(summary).not.toContain('undefined');
    expect(summary).not.toContain('surface');
    expect(reference).toEqual(before);
  });
  it.each([['wall', '側面'], ['floor', '下'], ['entry-cap', '入口']] as const)('穴の%sを翻訳された意味と現在位置で説明する', (role, label) => {
    const { reference } = setup(false);
    const holeReference: SubShapeRef = { ...reference, origin: { version: 1, shapeKind: 'face', identity: {
      kind: 'hole-face', featureId: 'hole', center: { sketchId: 'sketch-1', producer: { kind: 'point', featureId: 'center' } },
      placement: { kind: 'original' }, stage: 'bore', role,
    } } };
    const summary = summarizeRepairReference(holeReference);
    expect(summary).toContain(`穴の面 ${label}`);
    expect(summary).toContain(` / ${reference.bodyFeatureId} / `);
    expect(summary).toContain(' mm');
  });
  it.each([false, true])('番号交換=%sでも候補の意味と現在位置を表示し、加工・外観・基準・選択を再検査する', swapped => {
    const { slot, first } = setup(swapped), session = beginReferenceRepair(slot.key);
    if (session === null) throw new Error('修復セッションが必要');
    expect(session.status).toBe('missing');
    const top = session.candidates.find(candidate => candidate.reference.origin?.identity.kind === 'box-face'
      && candidate.reference.origin.identity.role === 'top');
    if (top === undefined) throw new Error('上面候補が必要');
    expect(top.reference.index).toBe(first);
    expect(summarizeRepairReference(top.reference)).toContain('箱の面 上');
    expect(summarizeRepairReference(top.reference)).toContain('(0, 0, 10) mm');
    expect(session.impacts.map(item => [item.ownerId, item.status])).toEqual([
      ['hole', 'missing'], ['center', 'missing'], ['surface-color', 'missing'], ['selection-set', 'missing'],
    ]);
    expect(commitReferenceRepair(session, top)).toBe('applied');
    expect(referenceRepairImpacts(useAppStore.getState(), slot).every(item => item.status === 'pending')).toBe(true);
    useAppStore.setState({ completedGeneration: 2, requestedGeneration: 2, isComputing: false });
    expect(referenceRepairImpacts(useAppStore.getState(), slot).map(item => [item.ownerId, item.status])).toEqual([
      ['hole', 'matched'], ['center', 'missing'], ['surface-color', 'missing'], ['selection-set', 'missing'],
    ]);
  });
  it('分割起点はホバー候補として表示するが番号参照への格下げで確定しない', () => {
    const { body, slot } = setup(false);
    const split: SolidBody = { ...body, origins: { version: 1, state: 'tracked', bindings: [
      { origin: origin('right'), state: 'split', candidates: [{ kind: 'face', index: 0 }, { kind: 'face', index: 1 }] },
    ] } };
    expect(repairResolution({ ...slot, bodies: [split] }).status).toBe('ambiguous');
    const candidates = repairCandidates({ ...slot, bodies: [split] });
    expect(candidates).toHaveLength(2);
    expect(candidates.every(candidate => !candidate.selectable && candidate.reference.origin !== undefined)).toBe(true);
  });
  it('一意の元参照と同じ候補の確定は履歴0', () => {
    const { slot, body, first } = setup(false), reference = createSubShapeReference(body, 'face', first);
    if (reference === null) throw new Error('現在参照が必要');
    slot.apply(useAppStore.getState(), reference);
    useAppStore.setState({ isComputing: false });
    const session = beginReferenceRepair(slot.key);
    if (session === null) throw new Error('修復セッションが必要');
    const before = useAppStore.getState();
    const candidate = session.candidates.find(candidate => candidate.reference.index === first);
    if (candidate === undefined) throw new Error('同じ候補が必要');
    expect(commitReferenceRepair(session, candidate)).toBe('unchanged');
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    cancelReferenceRepair(session);
  });
  it('修復欄を直接持たない下流の体積測定も、後続加工からたどって再検査する', () => {
    const { slot } = setup(false), before = useAppStore.getState();
    const document: PartDocument = { ...before.document, solids: [...before.document.solids, holeFeature('downstream', 'hole')],
      mathGeometry: [{ id: 'volume', name: '後続の体積', documentId: before.document.id,
        quantity: { kind: 'volume', body: { kind: 'body', featureId: 'downstream' } }, tolerance: { linearMm: 1e-7, angularRadians: 1e-9 } }] };
    useAppStore.getState().applyDocument(document);
    useAppStore.setState({ isComputing: false, completedGeneration: 2, requestedGeneration: 2,
      mathGeometryResult: { document, generation: 2, evaluated: true, outcomes: new Map([['volume', {
        id: 'volume', documentId: document.id, generation: 2, status: 'unresolved', reason: 'failed-geometry', message: '後続加工が未解決',
      }]]) } });
    const impacts = referenceRepairImpacts(useAppStore.getState(), slot);
    expect(impacts.find(item => item.ownerId === 'downstream')).toBeDefined();
    expect(impacts.find(item => item.ownerId === 'volume')).toMatchObject({ status: 'missing', issue: '後続加工が未解決' });
  });
});
