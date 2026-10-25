import { describe, expect, it } from 'vitest';
import { createAnalyticCellBudget, type AnalyticPlcFaceBinding } from './analysisSurfaceCertificate.js';
import { analyticChartAdmission, bindPoleOccurrences, type AdmissionChart, type NativeEdgeRecord } from './analyticChartAdmission.js';
import type { B08WireChain } from './boundary08Adapter.js';

// AUTHOR-ONLY, UNEXECUTED. Root places this beside boundary-08 analysisSurfaceCertificate.ts (kernel selector).
// Fully typed fixtures (no casts); expectations are hand-derived.
const tick = (): void => undefined;
const occurrence = (segmentIndex: number, edgeIndex: number, firstVertex: number, lastVertex: number) => ({
  faceIndex: 0, wireIndex: 0, segmentIndex, edgeIndex, firstVertex, lastVertex, first: 0, last: 1, forward: true, faceForward: true });
function wire(segments: readonly { nodes: readonly [number, number]; edge: number; v0: number; v1: number }[]): B08WireChain {
  return { localNodes: [...segments.map(s => s.nodes[0]), segments[0].nodes[0]], segments: segments.map((s, i) => ({
    localNodes: s.nodes, forward: true, trim: { edgeIndex: i, parameters: [0, 1], secondDerivativeBoundUv: 0 },
    identity: occurrence(i, s.edge, s.v0, s.v1) })) };
}

describe('pole identity binding (native vertex + collapsed PLC node)', () => {
  const poleWire = wire([{ nodes: [2, 3], edge: 7, v0: 5, v1: 5 }]);
  const face: AnalyticPlcFaceBinding = { faceIndex: 0, localToGlobal: [10, 11, 40, 40], plcTriangles: [] };
  it('binds a degenerated edge to its single native vertex and collapsed PLC node', () => {
    const records = new Map<number, NativeEdgeRecord>([[7, { nodes: [40, 40], degenerated: true }]]);
    const bound = bindPoleOccurrences([poleWire], records, face);
    expect(bound.poles).toEqual([{ edgeIndex: 7, nativeVertex: 5, plcNode: 40 }]);
    expect(bound.classes.get('2:3')).toEqual({ kind: 'pole', poleVertex: 5 });
  });
  it('refuses two native vertices, two PLC nodes, a local node bound elsewhere and a missing record', () => {
    expect(() => bindPoleOccurrences([wire([{ nodes: [2, 3], edge: 7, v0: 5, v1: 6 }])],
      new Map([[7, { nodes: [40, 40], degenerated: true }]]), face)).toThrow('without one native pole vertex');
    expect(() => bindPoleOccurrences([poleWire], new Map([[7, { nodes: [40, 41], degenerated: true }]]), face)).toThrow('more than one PLC node');
    expect(() => bindPoleOccurrences([poleWire], new Map([[7, { nodes: [40, 40], degenerated: true }]]),
      { ...face, localToGlobal: [10, 11, 40, 41] })).toThrow('not bound to the collapsed PLC node');
    expect(() => bindPoleOccurrences([poleWire], new Map(), face)).toThrow('missing native edge record');
  });
  it('never classifies a non-degenerated edge as a pole', () => {
    expect(bindPoleOccurrences([poleWire], new Map([[7, { nodes: [40, 40], degenerated: false }]]), face).poles).toEqual([]);
  });
});

describe('composed admission: validateAnalyticUvComplex runs first on the same arrays', () => {
  it('refuses Astra nested positive triangles before any cover logic or budget use', () => {
    const chart: AdmissionChart = { faceIndex: 0, surface: { kind: 'plane', scale: 1 }, geometry: { coneSemiAngle: null },
      uvNodes: [[0, 0], [4, 0], [0, 4], [1, 1], [2, 1], [1, 2]], localTriangles: [[0, 1, 2], [3, 4, 5]], uPeriod: null, vPeriod: null };
    const wires = [wire([{ nodes: [0, 1], edge: 0, v0: 0, v1: 1 }, { nodes: [1, 2], edge: 1, v0: 1, v1: 2 }, { nodes: [2, 0], edge: 2, v0: 2, v1: 0 }]),
      wire([{ nodes: [3, 4], edge: 3, v0: 3, v1: 4 }, { nodes: [4, 5], edge: 4, v0: 4, v1: 5 }, { nodes: [5, 3], edge: 5, v0: 5, v1: 3 }])];
    const budget = createAnalyticCellBudget(2, tick);
    expect(() => analyticChartAdmission(chart, wires, new Map(), { faceIndex: 0, localToGlobal: [0, 1, 2, 3, 4, 5], plcTriangles: [0, 1] },
      budget, tick)).toThrow('analytic-certificate');
    expect(budget.used()).toBe(0);
  });
});
