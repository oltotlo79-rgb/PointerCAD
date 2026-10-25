import { describe, expect, it } from 'vitest';
import { createAnalyticCellBudget, type AnalyticPlcFaceBinding } from './analysisSurfaceCertificate.js';
import { analyticChartAdmission, type AdmissionChart, type NativeEdgeRecord } from './analyticChartAdmissionR2.js';
import type { B08WireChain } from './boundary08Adapter.js';

// Root-only projection beside the actual admission modules. No native or test execution by this author.
const tick = (): void => undefined;
const chart: AdmissionChart = {
  faceIndex: 0, surface: { kind: 'plane', scale: 1 }, geometry: { coneSemiAngle: null },
  uvNodes: [[0, 0], [2, 0], [0, 2]], localTriangles: [[0, 1, 2]], uPeriod: null, vPeriod: null,
};
const wires: readonly B08WireChain[] = [{
  localNodes: [0, 1, 2, 0],
  segments: [
    { localNodes: [0, 1], forward: true,
      trim: { edgeIndex: 0, parameters: [0, 1], secondDerivativeBoundUv: 0 },
      identity: { faceIndex: 0, wireIndex: 0, segmentIndex: 0, edgeIndex: 3,
        firstVertex: 0, lastVertex: 1, first: 0, last: 1, forward: true, faceForward: true } },
    { localNodes: [1, 2], forward: true,
      trim: { edgeIndex: 1, parameters: [0, 1], secondDerivativeBoundUv: 0 },
      identity: { faceIndex: 0, wireIndex: 0, segmentIndex: 1, edgeIndex: 4,
        firstVertex: 1, lastVertex: 2, first: 0, last: 1, forward: true, faceForward: true } },
    { localNodes: [2, 0], forward: true,
      trim: { edgeIndex: 2, parameters: [0, 1], secondDerivativeBoundUv: 0 },
      identity: { faceIndex: 0, wireIndex: 0, segmentIndex: 2, edgeIndex: 5,
        firstVertex: 2, lastVertex: 0, first: 0, last: 1, forward: true, faceForward: true } },
  ],
}];
const records: ReadonlyMap<number, NativeEdgeRecord> = new Map([
  [3, { nodes: [10, 11], degenerated: false }],
  [4, { nodes: [11, 12], degenerated: false }],
  [5, { nodes: [12, 10], degenerated: false }],
]);
const plcFace: AnalyticPlcFaceBinding = { faceIndex: 0, localToGlobal: [10, 11, 12], plcTriangles: [7] };

describe('independent R2 complete admission path; a triangle of exact area 2', () => {
  it('accepts a coherent ordinary planar chart only as partial obligations', () => {
    const budget = createAnalyticCellBudget(1, tick);
    const result = analyticChartAdmission(chart, wires, records, plcFace, budget, tick);
    expect(result.faceIndex).toBe(0);
    expect(result.trimOccurrences).toBe(3);
    expect(result.seamPairs).toBe(0);
    expect(result.poles).toEqual([]);
    expect([...result.endpointObligations.keys()].sort()).toEqual([0, 1, 2]);
    for (const radius of result.endpointObligations.values()) {
      expect(Number.isFinite(radius)).toBe(true);
      expect(radius).toBeGreaterThanOrEqual(1);
      expect(radius).toBeLessThan(1.000000000001);
    }
    expect([...result.endpointsDischarged].sort()).toEqual([0, 1, 2]);
    expect(result.partial).toBe(true);
    expect(result.nativeGapsClosed).toBe(false);
    expect(result.geometricallyClosed).toBe(false);
    expect(result.materialVolumeCertified).toBe(false);
    expect(result.topologyCertified).toBe(false);
    expect(result.certificateEmitted).toBe(false);
    expect(budget.used()).toBe(9); // three cover, three corridor and three endpoint intervals share one counter
  });

  it('propagates cancellation before publishing any admission result', () => {
    const reason = new Error('independent-cancel');
    const budget = createAnalyticCellBudget(1, tick);
    expect(() => analyticChartAdmission(chart, wires, records, plcFace, budget, () => { throw reason; })).toThrow(reason);
    expect(budget.used()).toBe(0);
  });

  it('charges the new endpoint stage after cover and corridor exhausted all but two common cells', () => {
    const budget = createAnalyticCellBudget(1, tick);
    for (let i = 0; i < 24; i += 1) budget.consume();
    expect(() => analyticChartAdmission(chart, wires, records, plcFace, budget, tick)).toThrow('certificate-limit');
    expect(budget.used()).toBe(32);
  });

  it('refuses a missing actual native edge record on that same otherwise valid chart', () => {
    const missing = new Map(records);
    missing.delete(4);
    expect(() => analyticChartAdmission(chart, wires, missing, plcFace,
      createAnalyticCellBudget(1, tick), tick)).toThrow('missing native edge record');
  });

  it('accepts a regular cone chart through the actual R2 entry without claiming a certificate', () => {
    // Radius(v) = 1 + v sin(0.5), 0 <= v <= 2: positive independently of the production enclosure.
    // This is an analytic chart control, not a native CAD fixture or a material-domain certificate.
    const coneChart: AdmissionChart = { ...chart,
      surface: { kind: 'cone', referenceRadius: 1, scale: 1 },
      geometry: { coneSemiAngle: 0.5 }, uPeriod: 2 * Math.PI };
    const result = analyticChartAdmission(coneChart, wires, records, plcFace,
      createAnalyticCellBudget(1, tick), tick);
    expect([...result.endpointsDischarged].sort()).toEqual([0, 1, 2]);
    expect(result.poles).toEqual([]);
    expect(result.certificateEmitted).toBe(false);
    expect(result.geometricallyClosed).toBe(false);
  });

  it('rejects a cone chart that crosses its apex through the actual R2 entry', () => {
    // sin(0.5) >= 0.5 - 0.5^3/6 = 23/48, hence radius(-4) <= 1 - 23/12 < 0;
    // radius(0) = 1. The radial sign therefore changes inside the chart. No pole is supplied.
    const crossing: AdmissionChart = { ...chart,
      surface: { kind: 'cone', referenceRadius: 1, scale: 1 },
      geometry: { coneSemiAngle: 0.5 }, uPeriod: 2 * Math.PI,
      uvNodes: [[0, -4], [2, -4], [0, 0]] };
    expect(() => analyticChartAdmission(crossing, wires, records, plcFace,
      createAnalyticCellBudget(1, tick), tick)).toThrow('chart crosses the cone apex');
  });
});
