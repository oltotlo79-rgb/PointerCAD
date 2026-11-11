import { expressionValueFromNumber as ev } from '@pointercad/expression';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { commitNumericInput, createNumericInput, reduceNumericInput, SOLID_TOOL_STEPS } from '../sketch/numericInput.js';
import { commitSolidInput, solidToolReadiness } from './solidCommands.js';
import { subShapeElementId, type SubShapeBody } from './subShapeSelection.js';

const base = appendSolid(createEmptyPartDocument(), { id: 'box', name: 'Box', kind: 'primitive', suppressed: false,
  origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, 4) }, axis: { kind: 'world', axis: 'z' },
  shape: { kind: 'box', sizeX: ev(40), sizeY: ev(30), sizeZ: ev(8) } });
const body: SubShapeBody = { featureId: 'box', mesh: { edgePositions: new Float32Array(0) }, vertices: [],
  faces: [0, 1].map(index => ({ index, surfaceKind: index === 0 ? 'plane' : 'cylinder', area: 1200,
    centroid: [20, 15, 8], axis: [0, 0, 1], radius: index === 0 ? null : 3, triangleOffset: 0, triangleCount: 2 })),
  edges: [0, 1, 2].map(index => ({ index, curveKind: index === 1 ? 'circle' : 'line', length: 40,
    midpoint: [20, 0, index === 2 ? 0 : 8], start: [0, 0, index === 2 ? 0 : 8], end: [40, 0, index === 2 ? 0 : 8],
    axis: [1, 0, 0], radius: index === 1 ? 3 : null, segmentOffset: 0, segmentCount: 1 })) };
const face = subShapeElementId('box', 'face', 0), hole = subShapeElementId('box', 'face', 1);
const edge = subShapeElementId('box', 'edge', 0);

describe('direct edit selection and expression input', () => {
  it.each([[face, edge], [edge, face]])('rotation materials ignore selection order: %s %s', (first, second) => {
    const selected = [first, second];
    expect(solidToolReadiness(base, selected, 'faceRotate', [body])).toEqual({ ready: true, reasonKey: null });
    const result = commitSolidInput(base, selected, { kind: 'solid', tool: 'faceRotate', step: 'faceRotateAngle',
      values: { rotationAngle: ev(5) }, flags: {} }, [body]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reasonKey);
    expect(result.document.solids.at(-1)).toMatchObject({ kind: 'faceRotate', targetFeatureId: 'box',
      face: { index: 0 }, hinge: { index: 0 }, angle: ev(5) });
    expect(base.solids).toHaveLength(1);
  });
  it.each([
    ['holeTranslate', [], 'directEditError.oneCylinder'],
    ['holeTranslate', [hole, face], 'directEditError.oneCylinder'],
    ['holeTranslate', [face], 'directEditError.oneCylinder'],
    ['faceRotate', [face], 'directEditError.faceAndEdge'],
    ['faceRotate', [face, edge, hole], 'directEditError.faceAndEdge'],
    ['faceRotate', [face, 'other#edge:0'], 'directEditError.sameBody'],
    ['faceRotate', [face, 'box#edge:1'], 'directEditError.straightHinge'],
    ['faceRotate', [face, 'box#edge:2'], 'directEditError.hingeOnFace'],
    ['faceRotate', [hole, edge], 'shapeError.noFlatFace'],
    ['faceRotate', [face, 'box#edge:999'], 'directEditError.faceAndEdge'],
  ] as const)('%s rejects invalid selection %s', (tool, selected, reasonKey) => {
    expect(solidToolReadiness(base, selected, tool, [body, { ...body, featureId: 'other' }]))
      .toEqual({ ready: false, reasonKey });
  });
  it.each(['holeTranslate', 'faceRotate'] as const)('%s passes expressions in one input step', tool => {
    let input = createNumericInput(tool, SOLID_TOOL_STEPS[tool]);
    const key = tool === 'holeTranslate' ? 'translationX' : 'rotationAngle';
    input = reduceNumericInput(input, { type: 'edit', index: 0, source: tool === 'holeTranslate' ? '1+1' : '-10/2' });
    const transition = commitNumericInput(input);
    if (transition.kind !== 'solidCommitted') throw new Error('Expected one committed numeric step');
    expect(transition.commit.tool).toBe(tool);
    expect(transition.commit.values[key]?.source).toBe(tool === 'holeTranslate' ? '1+1' : '-10/2');
    const result = commitSolidInput(base, tool === 'holeTranslate' ? [hole] : [edge, face], transition.commit, [body]);
    expect(result.ok).toBe(true);
  });
  it.each(['holeTranslate', 'faceRotate'] as const)('%s rejects zero and nonfinite values without changing its base', tool => {
    const snapshot = structuredClone(base);
    for (const value of [0, NaN, Infinity]) {
      const result = commitSolidInput(base, tool === 'holeTranslate' ? [hole] : [face, edge], {
        kind: 'solid', tool, step: SOLID_TOOL_STEPS[tool], flags: {}, values: tool === 'holeTranslate'
          ? { translationX: { source: String(value), value, display: String(value) }, translationY: ev(0), translationZ: ev(0) }
          : { rotationAngle: { source: String(value), value, display: String(value) } },
      }, [body]);
      expect(result).toEqual({ ok: false, reasonKey: tool === 'holeTranslate' ? 'directEditError.translation' : 'directEditError.angle' });
      expect(base).toEqual(snapshot);
    }
  });
});
