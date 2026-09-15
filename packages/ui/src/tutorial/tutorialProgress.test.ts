import { describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendFeature, appendSolid, createEmptyPartDocument, createPointFeature, replaceSketch } from '@pointercad/model';
import { extrudeFeature, holeFeature } from '../store/testing/createTestStore.js';
import { createTutorialSession, tutorialStep } from './tutorialProgress.js';

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
