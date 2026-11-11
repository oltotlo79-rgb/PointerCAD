import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurveSpec, SubShapeQuery, Vec3Tuple } from '../types.js';
import * as boolean from './booleanOp.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makeCut } from './makeCut.js';
import { makeEmboss } from './makeEmboss.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';
import { extractEdges } from './extractEdges.js';
import { isValidShape, measureVolume } from './solidMesh.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });
afterEach(() => { vi.restoreAllMocks(); });

function observeBooleanResults(onResult?: (result: ReturnType<typeof boolean.booleanOp>, tool: Parameters<typeof boolean.booleanOp>[3]) => void) {
  const original = boolean.booleanOp;
  const releases: (() => void)[] = [];
  vi.spyOn(boolean, 'booleanOp').mockImplementation((...args) => {
    const result = original(...args);
    const release = vi.fn(() => { result.delete(); });
    releases.push(release);
    onResult?.(result, args[3]);
    return { ...result, delete: release };
  });
  return releases;
}

const cut = { origin: [0, 0, 5], normal: [0, 0, 1], keepPositive: true } as const;

function embossFixture(shape: ReturnType<typeof makeBox>['shape']) {
  const tables = collectSubShapes(oc, shape, tessellate(oc, shape).faceRanges, extractEdges(oc, shape).edgeRanges);
  const top = tables.faces.find(face => face.surfaceKind === 'plane' && face.axis?.[2] === 1);
  if (top === undefined) throw new Error('top face fixture missing');
  const face: Extract<SubShapeQuery, { kind: 'face' }> = {
    kind: 'face', index: top.index, surfaceKind: top.surfaceKind, area: top.area,
    position: top.centroid, axis: top.axis, radius: top.radius,
  };
  const corners: readonly Vec3Tuple[] = [[2, 2, 10], [4, 2, 10], [4, 4, 10], [2, 4, 10]];
  const profile: CurveSpec[] = corners.map((from, index) => ({
    kind: 'segment', from, to: corners[(index + 1) % corners.length],
  }));
  return { tables, input: { face, profiles: [profile], depth: 1 } };
}

describe('pending result remains owned until temporary tools finish releasing', () => {
  it('cut transfers a live independent result and leaves its borrowed target alive', () => {
    const target = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    const releases = observeBooleanResults();
    try {
      const result = makeCut(oc, target.shape, cut);
      try {
        expect(releases).toHaveLength(1);
        expect(releases[0]).not.toHaveBeenCalled();
        expect(isValidShape(oc, result.shape)).toBe(true);
        expect(measureVolume(oc, result.shape)).toBeCloseTo(500, 8);
        expect(measureVolume(oc, target.shape)).toBeCloseTo(1000, 8);
      } finally { result.delete(); }
      expect(releases[0]).toHaveBeenCalledTimes(1);
    } finally { target.delete(); }
  });

  it('cut reclaims the native result if temporary plane deletion fails', () => {
    const target = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    const releases = observeBooleanResults();
    const NativePlane = oc.gp_Pln_3, failure = new Error('temporary plane release failure');
    vi.spyOn(oc, 'gp_Pln_3').mockImplementationOnce(function (...args) {
      const plane = new NativePlane(...args), release = plane.delete.bind(plane);
      plane.delete = () => { release(); throw failure; };
      return plane;
    });
    try {
      expect(() => makeCut(oc, target.shape, cut)).toThrow(failure);
      expect(releases).toHaveLength(1);
      expect(releases[0]).toHaveBeenCalledTimes(1);
      expect(isValidShape(oc, target.shape)).toBe(true);
      expect(measureVolume(oc, target.shape)).toBeCloseTo(1000, 8);
    } finally { target.delete(); }
  });

  it.each([false, true])('emboss transfers the valid result only after tool cleanup (raised=%s)', raised => {
    const target = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    const fixture = embossFixture(target.shape), releases = observeBooleanResults();
    try {
      const result = makeEmboss(oc, target.shape, fixture.tables, { ...fixture.input, raised });
      try {
        expect(releases).toHaveLength(1);
        expect(releases[0]).not.toHaveBeenCalled();
        expect(isValidShape(oc, result.shape)).toBe(true);
        expect(result.volume).toBeCloseTo(raised ? 1004 : 996, 7);
        expect(measureVolume(oc, target.shape)).toBeCloseTo(1000, 8);
      } finally { result.delete(); }
      expect(releases[0]).toHaveBeenCalledTimes(1);
    } finally { target.delete(); }
  });

  it.each([false, true])('emboss reclaims its native result on tool cleanup failure (raised=%s)', raised => {
    const target = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    const fixture = embossFixture(target.shape), failure = new Error('temporary tool release failure');
    const createdVolumes: number[] = [];
    const releases = observeBooleanResults((result, tool) => {
      // Arm only after the real Boolean operation returned its native result.
      createdVolumes.push(result.volume);
      const release = tool.delete.bind(tool);
      tool.delete = () => { release(); throw failure; };
    });
    try {
      let thrown: unknown;
      try { makeEmboss(oc, target.shape, fixture.tables, { ...fixture.input, raised }); }
      catch (error) { thrown = error; }
      expect(thrown).toBe(failure);
      expect(releases).toHaveLength(1);
      expect(createdVolumes).toHaveLength(1);
      expect(createdVolumes[0]).toBeCloseTo(raised ? 1004 : 996, 7);
      expect(releases[0]).toHaveBeenCalledTimes(1);
      expect(isValidShape(oc, target.shape)).toBe(true);
      expect(measureVolume(oc, target.shape)).toBeCloseTo(1000, 8);
    } finally { target.delete(); }
  });
});
