import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from './referenceRepairFixture.js';
import { beginReferenceRepair, cancelReferenceRepair, commitReferenceRepair, hoverReferenceRepair,
  referenceRepairCurrent } from './referenceRepair.js';
import { currentRepairSlots } from './referenceRepairContext.js';
import { repairCandidates, repairResolution } from './referenceRepairCandidates.js';

function setup(positiveBacking = false) {
  const original = repairFixture();
  const fixture = positiveBacking ? { ...original, body: { ...original.body, mesh: { ...original.body.mesh,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) } } } : original;
  useAppStore.getState().applyDocument(fixture.document);
  useAppStore.setState({ bodies: [fixture.body], completedGeneration: 1, requestedGeneration: 1,
    isComputing: false, recomputeCancelled: false, timelineIndex: null, lastOutcome: 'success' });
  const slot = currentRepairSlots(useAppStore.getState())[0];
  const session = beginReferenceRepair(slot.key);
  if (session === null || session.candidates.length !== 2) throw new Error('修復fixtureが必要');
  return { ...fixture, slot, session, candidate: session.candidates[0] };
}

beforeEach(resetTestStore);
afterEach(resetTestStore);

describe('参照の修復は確定だけを一履歴にする', () => {
  it('消失・曖昧・一意を共通resolverの結果で区別する', () => {
    const { slot, body } = setup();
    expect(repairResolution(slot).status).toBe('ambiguous');
    expect(repairResolution({ ...slot, bodies: [] }).status).toBe('missing');
    expect(repairResolution({ ...slot, bodies: [{ ...body, edges: body.edges.slice(0, 1) }] }).status).toBe('matched');
    expect(repairCandidates({ ...slot, bodies: [{ ...body, isValid: false }] })).toEqual([]);
    expect(repairCandidates({ ...slot, bodies: [body, body] })).toEqual([]);
    expect(repairCandidates({ ...slot, bodies: [{ ...body, edges: [body.edges[0], body.edges[0]] }] })).toEqual([]);
    expect(repairCandidates({ ...slot, bodies: [{ ...body, edges: [{ ...body.edges[0], length: NaN }] }] })).toEqual([]);
  });
  it('候補ホバーと取消は文書・Undo/Redo・dirtyを全く変更しない', () => {
    const { session, candidate } = setup(), before = useAppStore.getState(), saved = JSON.stringify(before.document);
    for (const current of session.candidates) {
      expect(hoverReferenceRepair(session, current)).toBe(true);
      expect(useAppStore.getState().hoveredElementId).toBe(`base#edge:${current.reference.index}`);
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    }
    cancelReferenceRepair(session);
    const after = useAppStore.getState();
    expect(after.hoveredElementId).toBeNull();
    expect(after.document).toBe(before.document);
    expect(JSON.stringify(after.document)).toBe(saved);
    expect(after.undoStack).toBe(before.undoStack);
    expect([after.canUndo, after.canRedo, after.savedDocument]).toEqual([before.canUndo, before.canRedo, before.savedDocument]);
    expect(commitReferenceRepair(session, candidate)).toBe('stale');
  });
  it('候補確定で一つの保存欄だけを変えて1履歴、二重確定0、Undoで元参照へ戻す', () => {
    const { session, candidate, document } = setup(), before = useAppStore.getState();
    expect(candidate.selectable).toBe(true);
    expect(commitReferenceRepair(session, candidate)).toBe('applied');
    const after = useAppStore.getState();
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(after.document).toEqual({ ...document, solids: [document.solids[0], { ...document.solids[1], targets: [candidate.reference] }] });
    expect(after.document.solids[0]).toBe(document.solids[0]);
    expect(commitReferenceRepair(session, candidate)).toBe('stale');
    expect(useAppStore.getState().undoStack).toBe(after.undoStack);
    after.undo();
    expect(useAppStore.getState().document).toBe(document);
  });
  it('候補一覧にない値と別セッションの候補を採らない', () => {
    const { session, candidate } = setup(), before = useAppStore.getState();
    expect(commitReferenceRepair(session, { ...candidate })).toBe('unavailable');
    expect(hoverReferenceRepair(session, { ...candidate })).toBe(false);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    cancelReferenceRepair(session);
  });
});

describe('古い候補の採用0', () => {
  const changes: readonly [string, (state: AppState) => Partial<AppState>][] = [
    ['文書差替え', state => ({ document: { ...state.document } })],
    ['文書切替', () => ({ activeDocumentId: 'another-document' })],
    ['文書世代', state => ({ documentVersion: state.documentVersion + 1 })],
    ['再計算要求', state => ({ requestedGeneration: state.requestedGeneration + 1 })],
    ['再計算完了', state => ({ completedGeneration: state.completedGeneration + 1, requestedGeneration: state.requestedGeneration + 1 })],
    ['同世代の形状差替え', state => ({ bodies: [...state.bodies] })],
    ['再計算中', () => ({ isComputing: true })],
    ['再計算取消', () => ({ recomputeCancelled: true })],
    ['計算部破損', () => ({ lastOutcome: 'workerBroken' })],
    ['ロールバック', () => ({ timelineIndex: 0 })],
  ];
  it.each(changes)('%sの後はホバーも確定も拒否し、文書と履歴を追加変更しない', (_name, change) => {
    const { session, candidate } = setup();
    hoverReferenceRepair(session, candidate);
    useAppStore.setState(change(useAppStore.getState()));
    const changed = useAppStore.getState();
    expect(referenceRepairCurrent(session)).toBe(false);
    expect(hoverReferenceRepair(session, candidate)).toBe(false);
    expect(commitReferenceRepair(session, candidate)).toBe('stale');
    expect(useAppStore.getState().document).toBe(changed.document);
    expect(useAppStore.getState().undoStack).toBe(changed.undoStack);
    expect(useAppStore.getState().hoveredElementId).toBeNull();
  });
  it('同じ文書オブジェクトへ戻っても古いセッションは復活しない', () => {
    const { session, candidate } = setup(), document = useAppStore.getState().document;
    useAppStore.setState({ document: { ...document } });
    useAppStore.setState({ document });
    expect(commitReferenceRepair(session, candidate)).toBe('stale');
  });
  it('ホバー解除通知の途中で文書が切り替わっても古い文書を上書きしない', () => {
    const { session, candidate } = setup(), original = useAppStore.getState().document;
    hoverReferenceRepair(session, candidate);
    const next = { ...original, name: '別文書' };
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.hoveredElementId === null && previous.hoveredElementId !== null) useAppStore.setState({ document: next });
    });
    try {
      expect(commitReferenceRepair(session, candidate)).toBe('stale');
      expect(useAppStore.getState().document).toBe(next);
    } finally { unsubscribe(); }
  });
});

describe('cancel retires accessors without asserting physical collection', () => {
  it('old session exposes no slot/candidate meshes after cancel while an actual strong borrower remains live', () => {
    const { session, candidate, body } = setup(true);
    const held = { body: candidate.body, positions: candidate.body.mesh.positions };
    expect(session.slot.bodies).toContain(body);
    expect(session.tokens).not.toContain(useAppStore.getState().bodies);
    expect(session.tokens).not.toContain(useAppStore.getState().document);
    cancelReferenceRepair(session);
    expect(session.slot.bodies).toEqual([]);
    expect(session.candidates).toEqual([]);
    expect(session.slot.hoverId(candidate.reference, session)).toBeNull();
    const before = useAppStore.getState();
    session.slot.apply(before, candidate.reference);
    expect(useAppStore.getState()).toBe(before);
    expect(held.body).toBe(body);
    expect(held.positions).toBe(body.mesh.positions);
    // No GC or zero-byte assertion: the caller still owns these actual arrays.
    expect(held.positions.buffer.byteLength).toBeGreaterThan(0);
    expect(held.positions.buffer.byteLength).toBe(body.mesh.positions.buffer.byteLength);
  });
  it('old cancellation cannot clear a newer session hover or resurrect a closed borrow after ABA', () => {
    const { session: old, slot, candidate: oldCandidate } = setup();
    cancelReferenceRepair(old);
    const current = beginReferenceRepair(slot.key);
    if (current === null || current.candidates.length === 0) throw new Error('Current session');
    expect(hoverReferenceRepair(current, current.candidates[0])).toBe(true);
    const hovered = useAppStore.getState().hoveredElementId;
    cancelReferenceRepair(old);
    expect(useAppStore.getState().hoveredElementId).toBe(hovered);
    expect(referenceRepairCurrent(current)).toBe(true);
    expect(commitReferenceRepair(old, oldCandidate)).toBe('stale');
    expect(old.slot.bodies).toEqual([]);
    cancelReferenceRepair(current);
  });
});
