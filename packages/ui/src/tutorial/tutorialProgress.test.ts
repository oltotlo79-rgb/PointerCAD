import { describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendFeature, appendSolid, createDrawingDocument, createEmptyPartDocument, createPointFeature, replaceSketch } from '@pointercad/model';
import type { DrawingView } from '@pointercad/drawing';
import { bodyFor, extrudeFeature, holeFeature } from '../store/testing/createTestStore.js';
import { TUTORIAL_CHECKPOINT_KEY, type TutorialCheckpoint } from './tutorialCheckpoint.js';
import { continuingParameterSession, createParameterTutorialSession, createTutorialSession,
  parameterCheckpointIdentity, parameterCheckpointInput, parameterCheckpointWriteGuard,
  parameterTutorialStep, resumeParameterTutorialSession, tutorialStep } from './tutorialProgress.js';

function fixture() {
  const initial = createEmptyPartDocument();
  const session = createTutorialSession(initial, 3);
  if (session === null) throw new Error('session missing');
  let sketch = initial.sketches[0];
  sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(0, 0, 0)));
  sketch = appendFeature(sketch, { kind: 'rectangle', id: session.outlineId, name: 'rectangle', planeId: 'xy',
    corner1: absoluteCoordinate(-30, -20, 0), corner2: absoluteCoordinate(30, 20, 0), construction: false });
  sketch = appendFeature(sketch, { kind: 'face', id: session.faceId, name: 'face', planeId: 'xy',
    boundary: [{ featureId: session.outlineId }], color: '#7aa2f7' });
  const profile = replaceSketch(initial, sketch);
  const solid = appendSolid(profile, extrudeFeature(session.extrudeId));
  const complete = appendSolid(solid, holeFeature(session.holeId, session.extrudeId));
  return { initial, session, profile, solid, complete };
}

describe('初回案内は実文書のつながりと実保存で進み、取消と文書交換で巻き戻る', () => {
  it('作成済みの文書を初期化せず、新しい案内を断る', () => {
    const { complete } = fixture(), before = JSON.stringify(complete);
    expect(createTutorialSession(complete, 3)).toBeNull();
    expect(JSON.stringify(complete)).toBe(before);
  });
  it('点・輪郭・面・押し出し・穴・保存の不足した段を独立に判断する', () => {
    const { initial, session, profile, solid, complete } = fixture();
    expect(tutorialStep(session, initial, 3, null)).toBe('point');
    for (const [count, expected] of [[1, 'outline'], [2, 'face'], [3, 'extrude']] as const) {
      const document = replaceSketch(profile, { ...profile.sketches[0], features: profile.sketches[0].features.slice(0, count) });
      expect(tutorialStep(session, document, 3, null)).toBe(expected);
    }
    expect(tutorialStep(session, solid, 3, null)).toBe('hole');
    expect(tutorialStep(session, complete, 3, null)).toBe('save');
    expect(tutorialStep(session, complete, 3, solid)).toBe('save');
    expect(tutorialStep(session, complete, 3, complete)).toBe('complete');
  });
  it('同じIDの別文書や別スケッチへ前の操作を持ち越さない', () => {
    const { session, complete } = fixture();
    expect(tutorialStep(session, complete, 4, complete)).toBe('differentDocument');
    expect(tutorialStep(session, { ...complete, activeSketchId: 'different' }, 3, complete)).toBe('differentDocument');
  });
  it('抑制した穴や別の板の穴を完成に数えず、元に戻した点も作り直す', () => {
    const { session, complete } = fixture();
    const suppressed = { ...complete, solids: complete.solids.map(item => item.id === session.holeId ? { ...item, suppressed: true } : item) };
    expect(tutorialStep(session, suppressed, 3, suppressed)).toBe('hole');
    const unrelated = { ...complete, solids: complete.solids.map(item => item.kind === 'hole' ? { ...item, targetFeatureId: 'other' } : item) };
    expect(tutorialStep(session, unrelated, 3, unrelated)).toBe('hole');
    const removed = replaceSketch(complete, { ...complete.sketches[0], features: complete.sketches[0].features.filter(item => item.id !== session.pointId) });
    expect(tutorialStep(session, removed, 3, removed)).toBe('point');
  });
});

describe('パラメータから出力までの案内は通常文書と成功結果から再導出する', () => {
  it('点、3mm立体、6mm立体、保存を別々に照合し、古いbodyとUndoを進行扱いしない', () => {
    const initial = createEmptyPartDocument();
    const session = createParameterTutorialSession(initial, 3);
    if (session === null) throw new Error('session missing');
    const empty = { ready: true, bodies: [], savedPart: null, activeDrawing: null };
    expect(parameterTutorialStep(session, initial, 3, empty)).toBe('pointCoordinates');
    expect(parameterCheckpointInput(session, initial, 'pointCoordinates')?.owned).toEqual({ sketchId: session.sketchId });
    let sketch = initial.sketches[0];
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(0, 0, 0)));
    const point = replaceSketch(initial, sketch);
    expect(parameterTutorialStep(session, point, 3, empty)).toBe('thicknessParameter');
    expect(parameterCheckpointInput(session, point, 'thicknessParameter')?.owned)
      .toEqual({ sketchId: session.sketchId, pointId: session.pointId });
    sketch = appendFeature(sketch, { kind: 'rectangle', id: session.outlineId, name: 'rectangle', planeId: 'xy',
      corner1: absoluteCoordinate(-30, -20, 0), corner2: absoluteCoordinate(30, 20, 0), construction: false });
    sketch = appendFeature(sketch, { kind: 'face', id: session.faceId, name: 'face', planeId: 'xy',
      boundary: [{ featureId: session.outlineId }], color: '#7aa2f7' });
    const profile = replaceSketch(initial, sketch);
    const three = appendSolid({ ...profile, parameters: [{ name: '板厚', unit: 'mm', description: '',
      value: { source: '3mm', value: 3, display: '3' } }] }, {
      ...extrudeFeature(session.extrudeId), profile: { sketchId: session.sketchId, faceFeatureId: session.faceId },
      distance: { source: '板厚', value: 3, display: '3' },
    });
    const body3 = { ...bodyFor(session.extrudeId), mesh: { ...bodyFor(session.extrudeId).mesh,
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 3]) } };
    const evidence3 = { ...empty, bodies: [body3], savedPart: three };
    expect(parameterTutorialStep(session, three, 3, evidence3)).toBe('dimensionChange');
    const six = { ...three, parameters: [{ ...three.parameters[0], value: { source: '6mm', value: 6, display: '6' } }],
      solids: three.solids.map(solid => solid.id === session.extrudeId && solid.kind === 'extrude'
        ? { ...solid, distance: { source: '板厚', value: 6, display: '6' } } : solid) };
    const body6 = { ...body3, mesh: { ...body3.mesh, positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 6]) } };
    expect(parameterTutorialStep(session, six, 3, { ...evidence3, bodies: [body3] })).toBe('dimensionChange');
    expect(parameterTutorialStep(session, six, 3, { ...evidence3, bodies: [body6] })).toBe('dimensionChange');
    expect(parameterTutorialStep(session, six, 3, { ...evidence3, bodies: [body6], savedPart: six })).toBe('drawing');
    expect(parameterTutorialStep(session, three, 3, evidence3)).toBe('dimensionChange');
    expect(parameterTutorialStep(session, six, 4, { ...evidence3, bodies: [body6], savedPart: six }))
      .toBe('differentDocument');
    const view: DrawingView = { id: 'front', name: 'front', kind: 'front', position: [100, 100],
      direction: [0, 0, 1], xDir: [1, 0, 0], scale: null, showHidden: true,
      showCenterLines: true, layerId: 'layer-1' };
    const source = { sourceRef: 'source-1', sourceKind: 'part' as const, fileName: 'part.pcad',
      path: '', contentHash: 'saved-source', importedAt: '2026-10-04T00:00:00.000Z' };
    const partialDrawing = { ...createDrawingDocument('drawing', source), views: [view] };
    const proof = { document: partialDrawing, sourcePart: six,
      sourceRef: source.sourceRef, sourceHash: source.contentHash };
    const saved = { ...evidence3, bodies: [body6], savedPart: six };
    expect(parameterTutorialStep(session, six, 3, { ...saved, activeDrawing: partialDrawing,
      drawingProof: proof })).toBe('drawing');
    const completeDrawing = { ...partialDrawing, views: [view,
      { ...view, id: 'top', kind: 'top' as const }, { ...view, id: 'right', kind: 'right' as const }] };
    const completeProof = { ...proof, document: completeDrawing };
    const drawingEvidence = { ...saved, activeDrawing: completeDrawing, drawingProof: completeProof };
    expect(parameterTutorialStep(session, six, 3, drawingEvidence)).toBe('stepStl');
    expect(parameterTutorialStep(session, six, 3, { ...drawingEvidence, exports: { step: six } })).toBe('stepStl');
    expect(parameterTutorialStep(session, six, 3, { ...drawingEvidence, exports: { step: six, stl: six } })).toBe('complete');
    expect(parameterTutorialStep(session, six, 3, { ...drawingEvidence,
      drawingProof: { ...completeProof, sourcePart: three } })).toBe('drawing');
    expect(parameterTutorialStep(session, six, 3, { ...drawingEvidence,
      drawingProof: { ...completeProof, sourceHash: 'stale-source' } })).toBe('drawing');
    expect(parameterTutorialStep(session, six, 3, { ...drawingEvidence,
      exports: { step: three, stl: six } })).toBe('stepStl');
  });
});

describe('保存済み原票の継続所有は段完了と独立して判定する', () => {
  it('同じpart-1の新規courseは既原票を継がず、実readの所有だけを継ぐ', () => {
    const part = createEmptyPartDocument();
    const newCourse = createParameterTutorialSession(part, 3);
    if (newCourse === null) throw new Error('session missing');
    const checkpoint: TutorialCheckpoint = { version: 1, course: 'parameterToExport',
      ownerPartId: part.id, savedKind: 'part', savedSha256: 'a'.repeat(64),
      partSourceHash: 'b'.repeat(64), stageHint: 'pointCoordinates',
      owned: { sketchId: part.activeSketchId } };
    let raw: string | null = JSON.stringify(checkpoint);
    const storage = { getItem: (key: string) => key === TUTORIAL_CHECKPOINT_KEY ? raw : null, setItem: (_key: string, value: string) => { raw = value; } };
    expect(parameterCheckpointWriteGuard(newCourse, storage, () => true))
      .toMatchObject({ ok: false, reason: 'storageConflict' });
    const resumed = resumeParameterTutorialSession(checkpoint, part, 3);
    if (resumed === null) throw new Error('resume missing');
    expect(resumed.checkpointIdentity).toBe(parameterCheckpointIdentity(checkpoint));
    const accepted = parameterCheckpointWriteGuard(resumed, storage, () => true);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.isCurrent()).toBe(true);
    raw = JSON.stringify({ ...checkpoint, draft: { kind: 'numeric', operation: 'point', mode: 'absolute',
      fields: [{ key: 'x', source: '1 +' }, { key: 'y', source: '' }, { key: 'z', source: '' }], focusedKey: 'x' } });
    expect(accepted.isCurrent()).toBe(false);
    expect(parameterCheckpointWriteGuard(resumed, storage, () => true).ok).toBe(true);
    raw = JSON.stringify({ ...checkpoint, savedSha256: 'c'.repeat(64) });
    expect(parameterCheckpointWriteGuard(resumed, storage, () => true))
      .toMatchObject({ ok: false, reason: 'storageConflict' });
    const liveResumed = { ...resumed, paused: false };
    expect(continuingParameterSession(newCourse, liveResumed)).toBe(true);
    expect(continuingParameterSession(liveResumed, newCourse)).toBe(false);
    expect(storage.getItem(TUTORIAL_CHECKPOINT_KEY)).toBe(raw);
  });
});
