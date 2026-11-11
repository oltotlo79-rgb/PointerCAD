import { beforeAll, expect, it } from 'vitest';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec } from '../types.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { writeBrepBytes } from './brepBytes.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePrimitive } from './makePrimitive.js';
import { makeExtrudeSolid } from './makeSolidSweep.js';
import { measureMassProperties } from './measureShape.js';
import { isValidShape } from './solidMesh.js';
import { extractSubShapeHistory, type SubShapeHistoryEntry } from './subShapeHistory.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });

const cases = [
  { label: '4x2 original', major: 4, minor: 2, scale: 1, moved: false },
  { label: '3x1.5 original', major: 3, minor: 1.5, scale: 1, moved: false },
  { label: '4x2 rigid placement', major: 4, minor: 2, scale: 1, moved: true },
  { label: '3x1.5 rigid placement', major: 3, minor: 1.5, scale: 1, moved: true },
  { label: '4x2 half scale', major: 4, minor: 2, scale: 0.5, moved: false },
  { label: '4x2 double scale', major: 4, minor: 2, scale: 2, moved: false },
] as const;

it.each(cases)('$label preserves analytic geometry, mass, input BRep and native history', ({ major, minor, scale, moved }) => {
  const owned = createAllocations();
  try {
    const a = major * scale, b = minor * scale, side = 10 * scale, length = 20 * scale;
    const profile: readonly CurveSpec[] = [{ kind: 'ellipse', center: [5 * scale, 5 * scale, -5 * scale],
      normal: [0, 0, 1], majorAxis: [1, 0, 0], majorRadius: a, minorRadius: b }];
    const box = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [5 * scale, 5 * scale, 5 * scale],
      axis: [0, 0, 1], shape: { kind: 'box', sizeX: side, sizeY: side, sizeZ: side }, originQuery: null, targetKey: null }));
    const prism = owned.keep(makeExtrudeSolid(oc, { kind: 'extrude', profile, direction: [0, 0, 1], distance: length }));
    const placement = owned.keep(new oc.gp_Trsf_1());
    if (moved) {
      const origin = owned.keep(new oc.gp_Pnt_3(0, 0, 0));
      const direction = owned.keep(new oc.gp_Dir_4(1, 2, 3));
      const axis = owned.keep(new oc.gp_Ax1_2(origin, direction));
      placement.SetRotation_1(axis, 0.73);
      const translation = owned.keep(new oc.gp_Vec_4(31, -29, 43));
      placement.SetTranslationPart(translation);
    }
    const targetBuilder = owned.keep(new oc.BRepBuilderAPI_Transform_2(box.shape, placement, true));
    const toolBuilder = owned.keep(new oc.BRepBuilderAPI_Transform_2(prism.shape, placement, true));
    const target = owned.keep(targetBuilder.Shape()), tool = owned.keep(toolBuilder.Shape());
    const targetBytes = writeBrepBytes(oc, target), toolBytes = writeBrepBytes(oc, tool);
    let history: readonly SubShapeHistoryEntry[] = [];
    const cut = owned.keep(booleanOp(oc, 'subtract', target, tool, undefined, (builder, output) => {
      expect(builder.IsDone()).toBe(true);
      history = extractSubShapeHistory(oc, builder, [{ sourceId: 'target', shape: target }, { sourceId: 'tool', shape: tool }], output);
    }, { requireRemoval: true }));
    const boxMass = side ** 3, removedMass = Math.PI * a * b * side;
    const expectedVolume = boxMass - removedMass;
    const measured = measureMassProperties(oc, cut.shape);
    expect(cut.volume).toBeCloseTo(expectedVolume, 6);
    expect(measured.volume).toBeCloseTo(expectedVolume, 6);
    const centre = owned.keep(new oc.gp_Pnt_3(5 * scale, 5 * scale, 5 * scale));
    const expectedCentre = owned.keep(centre.Transformed(placement));
    for (const [index, value] of [expectedCentre.X(), expectedCentre.Y(), expectedCentre.Z()].entries()) {
      expect(measured.centreOfMass[index]).toBeCloseTo(value, 7);
    }
    const boxMoment = boxMass * side ** 2 / 6;
    const expectedMoments = [boxMoment - removedMass * (b * b / 4 + side * side / 12),
      boxMoment - removedMass * (a * a / 4 + side * side / 12),
      boxMoment - removedMass * (a * a + b * b) / 4].sort((x, y) => x - y);
    const actualMoments = [...measured.principalMoments].sort((x, y) => x - y);
    for (const [index, expected] of expectedMoments.entries()) expect(actualMoments[index] / expected).toBeCloseTo(1, 8);
    const toolMass = measureMassProperties(oc, tool);
    const expectedToolMass = Math.PI * a * b * length;
    expect(toolMass.volume).toBeCloseTo(expectedToolMass, 6);
    for (const [index, value] of [expectedCentre.X(), expectedCentre.Y(), expectedCentre.Z()].entries()) {
      expect(toolMass.centreOfMass[index]).toBeCloseTo(value, 7);
    }
    const toolExpectedMoments = [expectedToolMass * (b * b / 4 + length * length / 12),
      expectedToolMass * (a * a / 4 + length * length / 12), expectedToolMass * (a * a + b * b) / 4].sort((x, y) => x - y);
    const toolActualMoments = [...toolMass.principalMoments].sort((x, y) => x - y);
    for (const [index, expected] of toolExpectedMoments.entries()) expect(toolActualMoments[index] / expected).toBeCloseTo(1, 8);
    const targetFaces = history.filter(row => row.sourceId === 'target' && row.input.kind === 'face');
    expect(targetFaces).toHaveLength(6);
    expect(targetFaces.every(row => row.modified.length === 1)).toBe(true);
    expect(history.some(row => row.generated.length > 0)).toBe(true);
    expect(isValidShape(oc, cut.shape)).toBe(true);
    expect(writeBrepBytes(oc, target)).toEqual(targetBytes);
    expect(writeBrepBytes(oc, tool)).toEqual(toolBytes);
  } finally { owned.release(); }
});

it('conditioned observer failure preserves both inputs and permits a real retry', () => {
  const owned = createAllocations();
  try {
    const box = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [5, 5, 5], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 10, sizeY: 10, sizeZ: 10 }, originQuery: null, targetKey: null }));
    const profile: readonly CurveSpec[] = [{ kind: 'ellipse', center: [5, 5, -5], normal: [0, 0, 1],
      majorAxis: [1, 0, 0], majorRadius: 4, minorRadius: 2 }];
    const prism = owned.keep(makeExtrudeSolid(oc, { kind: 'extrude', profile, direction: [0, 0, 1], distance: 20 }));
    const beforeBox = writeBrepBytes(oc, box.shape), beforeTool = writeBrepBytes(oc, prism.shape);
    const failure = new Error('conditioned observer stopped');
    expect(() => booleanOp(oc, 'subtract', box.shape, prism.shape, undefined, () => { throw failure; })).toThrow(failure);
    expect(writeBrepBytes(oc, box.shape)).toEqual(beforeBox);
    expect(writeBrepBytes(oc, prism.shape)).toEqual(beforeTool);
    const retry = owned.keep(booleanOp(oc, 'subtract', box.shape, prism.shape));
    expect(retry.volume).toBeCloseTo(1000 - 80 * Math.PI, 6);
  } finally { owned.release(); }
});
