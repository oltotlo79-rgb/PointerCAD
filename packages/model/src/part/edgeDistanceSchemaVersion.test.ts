import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { appendSolid, createEmptyPartDocument, PART_SCHEMA_VERSION, removeSolid, replaceSolid } from './createPartDocument.js';
import type { HoleFeature } from './types.js';

/** 辺からの距離の穴(M-02)を使った部品だけが版 24 を名乗る。開くだけ・消すだけでは版を変えない(統括の決定 2026-11-19)。 */
describe('保存形式の版 24 は辺からの距離の穴を使った部品だけ(M-02)', () => {
  const expression = (source: string): ExpressionValue => {
    const result = evaluateExpression(source);
    if (!result.ok) throw new Error(source);
    return result.value;
  };
  const face: SubShapeRef = { bodyFeatureId: 'box-1', index: 5,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 2400, position: [30, 20, 10], axis: [0, 0, 1], radius: null } };
  const edge = (index: number, axis: readonly [number, number, number]): SubShapeRef => ({ bodyFeatureId: 'box-1', index,
    fingerprint: { kind: 'edge', curveKind: 'line', length: 40, position: [60, 20, 10], axis, radius: null } });
  const plain: HoleFeature = { id: 'hole-1', name: '穴', suppressed: false, kind: 'hole', targetFeatureId: 'box-1', face,
    centers: [], diameter: expression('6'), depth: { kind: 'through' }, tiltAngle: expression('0'), tiltAzimuth: expression('0'),
    planar: { kind: 'plane-face', locations: [{ x: expression('6'), y: expression('-4') }] } };
  const byEdges: HoleFeature = { ...plain, planar: { kind: 'edge-distance', edge1: edge(3, [0, 1, 0]), edge2: edge(4, [1, 0, 0]),
    locations: [{ distance1: expression('8'), distance2: expression('8') }] } };

  it('今の版は 22 のまま。面内 X・Y の穴を足しても変えない', () => {
    const document = createEmptyPartDocument();
    expect(PART_SCHEMA_VERSION).toBe(22);
    expect(document.schemaVersion).toBe(22);
    expect(appendSolid(document, plain).schemaVersion).toBe(22);
  });

  it('辺からの距離の穴を足す・差し替えると版 24 になり、消しても下げない', () => {
    const added = appendSolid(createEmptyPartDocument(), byEdges);
    expect(added.schemaVersion).toBe(24);
    const replaced = replaceSolid(appendSolid(createEmptyPartDocument(), plain), plain.id, byEdges);
    expect(replaced.schemaVersion).toBe(24);
    expect(removeSolid(added, byEdges.id).schemaVersion).toBe(24);
    expect(replaceSolid(added, byEdges.id, plain).schemaVersion).toBe(24);
  });

  it('版 23 の文書(穴つきの面など)も、辺からの距離の穴を足した時だけ 24 になる', () => {
    const version23 = { ...createEmptyPartDocument(), schemaVersion: 23 };
    expect(appendSolid(version23, plain).schemaVersion).toBe(23);
    expect(appendSolid(version23, byEdges).schemaVersion).toBe(24);
  });
});
