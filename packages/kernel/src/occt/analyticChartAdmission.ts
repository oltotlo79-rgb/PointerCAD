/**
 * Composed analytic chart admission (AUTHOR-ONLY, UNEXECUTED; go-r10). Intended location when Root integrates:
 * packages/kernel/src/occt/analyticChartAdmission.ts beside boundary-08 analysisSurfaceCertificate.ts, with the candidate
 * helpers copied alongside under the same names. Imports below use the ACTUAL boundary-08 export names verified read-only:
 *   validateAnalyticUvComplex (line 747), createAnalyticCellBudget/AnalyticCellBudget (1643-1649), AnalyticFaceChart (90:
 *   uvNodes, localTriangles, uPeriod, vPeriod, surface, geometry), AnalyticWireChain (114), AnalyticPlcFaceBinding (305:
 *   localToGlobal), and the producer's per-edge native record { nodes, degenerated } used at lines 486-490.
 * Order on the SAME meshed-copy arrays: (1) validateAnalyticUvComplex FIRST (mandatory, unchanged); (2) native primitive
 * regularity from actual parameters; (3) native occurrence+interval inventory; (4) pole identity binding; (5) lifted
 * cover R3; (6) trim corridors R4 with endpoints read from the one canonical chart.uvNodes table; all work charged to the
 * ONE caller-provided AnalyticCellBudget. The result is a partial obligation record: every global flag is literal false.
 */
import {
  validateAnalyticUvComplex,
  type AnalyticCellBudget,
  type AnalyticFaceChart,
  type AnalyticPlcFaceBinding,
  type AnalyticSurfaceGeometry,
} from './analysisSurfaceCertificate.js';
import { buildTrimIntervalInventory, nativePrimitiveForInjectivity, sharedTake, type B08WireChain } from './boundary08Adapter.js';

/** Exactly the chart members used here; the real AnalyticFaceChart is assignable without any cast. */
export type AdmissionChart = Pick<AnalyticFaceChart, 'faceIndex' | 'surface' | 'uvNodes' | 'localTriangles' | 'uPeriod' | 'vPeriod'>
  & { readonly geometry: Pick<AnalyticSurfaceGeometry, 'coneSemiAngle'> };
/** The real AnalyticWireChain is structurally assignable to B08WireChain (identity/trim/localNodes subset). */
type AnalyticWireChain = B08WireChain;
import { assertLiftedChartCoverR2 as assertLiftedChartCover, type CoverBoundaryClass } from './analyticChartCoverR3.js';
import { assertDisjointTrimCorridors, type TrimChord } from './analyticTrimCorridorsR4.js';

/** The producer's actual per-native-edge record (records.get(identity.edgeIndex) in boundary-08). */
export interface NativeEdgeRecord {
  readonly nodes: readonly number[]; // global PLC node per polygon parameter
  readonly degenerated: boolean;
}

export interface PoleBinding {
  readonly edgeIndex: number;
  readonly nativeVertex: number;
  readonly plcNode: number;
}

function nextUp(value: number): number {
  if (!Number.isFinite(value)) throw new Error('chart-admission: nonfinite');
  if (value === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

/**
 * Pole identity: every degenerated native edge use must have firstVertex === lastVertex (the native pole vertex), all its
 * record nodes must be ONE collapsed PLC node, and every local node of the use must map to that PLC node via the actual
 * producer localToGlobal. Non-degenerated uses can never be poles.
 */
export function bindPoleOccurrences(wires: readonly AnalyticWireChain[], records: ReadonlyMap<number, NativeEdgeRecord>,
  plcFace: AnalyticPlcFaceBinding): { readonly classes: ReadonlyMap<string, CoverBoundaryClass>; readonly poles: readonly PoleBinding[] } {
  const classes = new Map<string, CoverBoundaryClass>();
  const poles: PoleBinding[] = [];
  for (const wire of wires) for (const segment of wire.segments) {
    const identity = segment.identity;
    if (identity === undefined) throw new Error('chart-admission: missing native occurrence identity');
    const record = records.get(identity.edgeIndex);
    if (record === undefined || record.nodes.length !== segment.localNodes.length) throw new Error('chart-admission: missing native edge record');
    if (!record.degenerated) continue;
    if (identity.firstVertex !== identity.lastVertex) throw new Error('chart-admission: degenerated edge without one native pole vertex');
    const plcNode = record.nodes[0];
    if (record.nodes.some(node => node !== plcNode)) throw new Error('chart-admission: pole edge maps to more than one PLC node');
    if (segment.localNodes.some(local => plcFace.localToGlobal[local] !== plcNode)) {
      throw new Error('chart-admission: pole local node not bound to the collapsed PLC node');
    }
    for (let k = 0; k + 1 < segment.localNodes.length; k += 1) {
      classes.set(`${segment.localNodes[k]}:${segment.localNodes[k + 1]}`, { kind: 'pole', poleVertex: identity.firstVertex });
    }
    poles.push({ edgeIndex: identity.edgeIndex, nativeVertex: identity.firstVertex, plcNode });
  }
  return { classes, poles };
}

export interface ChartAdmissionResult {
  readonly faceIndex: number;
  readonly trimOccurrences: number;
  readonly seamPairs: number;
  readonly poles: readonly PoleBinding[];
  /** Per chart node: endpoint-disk radius still to be covered by the boundary-06 endpoint cone (obligation). */
  readonly endpointObligations: ReadonlyMap<number, number>;
  readonly partial: true;
  readonly nativeGapsClosed: false;
  readonly geometricallyClosed: false;
  readonly materialVolumeCertified: false;
  readonly topologyCertified: false;
  readonly certificateEmitted: false;
}

export function analyticChartAdmission(chart: AdmissionChart, wires: readonly AnalyticWireChain[],
  records: ReadonlyMap<number, NativeEdgeRecord>, plcFace: AnalyticPlcFaceBinding, budget: AnalyticCellBudget,
  checkpoint: () => void): ChartAdmissionResult {
  // (1) Mandatory existing strong check on the identical arrays (rejects the nested-triangle construction).
  validateAnalyticUvComplex(chart.uvNodes, chart.localTriangles, wires.map(wire => wire.localNodes), checkpoint);
  if (plcFace.faceIndex !== chart.faceIndex || plcFace.localToGlobal.length !== chart.uvNodes.length) {
    throw new Error('chart-admission: producer face binding differs from the chart');
  }
  // (2) Actual primitive parameters (torus major > minor > 0; cone needs its native semi-angle and radius).
  nativePrimitiveForInjectivity(chart.surface, chart.geometry.coneSemiAngle);
  const take = sharedTake(budget);
  // (3) Native occurrence + interval inventory from the actual wires; (4) pole identities replace degenerated uses.
  const inventory = buildTrimIntervalInventory(chart.faceIndex, wires, checkpoint);
  const { classes: poleClasses, poles } = bindPoleOccurrences(wires, records, plcFace);
  const degenerate = new Set(poles.map(pole => pole.edgeIndex));
  const boundary = new Map<string, CoverBoundaryClass>();
  const trimRanges = new Map<number, readonly [number, number]>();
  for (const [key, value] of inventory.boundary) {
    if (value.kind === 'trim') {
      const tuple = inventory.occurrenceTable.get(value.occurrence) ?? '';
      const edgeIndex = Number(tuple.split(':')[3]);
      if (degenerate.has(edgeIndex)) continue;
      const range = inventory.trimRanges.get(value.occurrence);
      if (range === undefined) throw new Error('chart-admission: trim occurrence without range');
      trimRanges.set(value.occurrence, range);
    }
    boundary.set(key, value);
  }
  for (const [key, value] of poleClasses) {
    if (boundary.has(key)) throw new Error('chart-admission: pole edge also classified as trim or seam');
    boundary.set(key, value);
  }
  // (5) Lifted degree-1 cover with exact seam pairing and pole lines.
  const cover = assertLiftedChartCover({ surface: chart.surface.kind, nodes: chart.uvNodes, triangles: chart.localTriangles,
    uPeriod: chart.uPeriod, vPeriod: chart.vPeriod, boundary }, trimRanges, checkpoint, take);
  // (6) Corridors: endpoints come ONLY from the canonical chart.uvNodes table indexed by the native interval nodes.
  const chords: TrimChord[] = [];
  const bound = new Map<string, number>();
  wires.forEach(wire => wire.segments.forEach(segment => {
    if (segment.identity !== undefined) bound.set(`${segment.identity.edgeIndex}`, segment.trim.secondDerivativeBoundUv);
  }));
  for (const row of inventory.rows) {
    if (row.seam || degenerate.has(row.occurrence.edgeIndex)) continue;
    const m = bound.get(`${row.occurrence.edgeIndex}`);
    if (m === undefined) throw new Error('chart-admission: missing native second-derivative bound');
    const length = nextUp(Math.abs(row.end - row.start));
    // Chord key = position in the inventory's own native row order (tuple + interval), never a caller label.
    chords.push({ occurrence: chords.length, interval: 0, from: row.from, to: row.to,
      a: chart.uvNodes[row.from], b: chart.uvNodes[row.to], secondDerivativeBound: m, parameterLength: length });
  }
  const endpointObligations = chords.length === 0 ? new Map<number, number>() : assertDisjointTrimCorridors(chords, checkpoint, take);
  return { faceIndex: chart.faceIndex, trimOccurrences: cover.trimOccurrences.length, seamPairs: cover.seamPairs, poles,
    endpointObligations, partial: true, nativeGapsClosed: false, geometricallyClosed: false, materialVolumeCertified: false,
    topologyCertified: false, certificateEmitted: false };
}
