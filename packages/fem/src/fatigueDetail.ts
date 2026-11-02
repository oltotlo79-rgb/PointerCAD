import { FATIGUE_PIECEWISE_INPUT_SCHEMA, analyzeFatiguePiecewise, validateFatiguePiecewiseInput, type FatiguePiecewiseCurve,
  type FatiguePiecewiseError, type FatiguePiecewiseErrorCode, type FatiguePiecewiseInput, type FatiguePiecewiseResult } from './fatiguePiecewise.js';
import { MAX_FATIGUE_HISTORIES, MAX_FATIGUE_HISTORY_POINTS, type FatigueSequence, type FatigueSource,
  type FatigueStressHistory } from './fatigueModel.js';

/**
 * Joint (weld or bolt) nominal-stress fatigue on ONE user-supplied S-N calibration. The user selects the joint, states
 * which quantity was taken where (a force carried by the joint, or a stress already in the joint's stress definition),
 * and states which stress the calibration was derived for. The joint geometry gives the area; a force history becomes
 * the nominal stress history F / A, and the unchanged rainflow, Miner, strict readers and life of fatiguePiecewise.ts
 * do the rest. The joint's stress definition, the loading's and the curve's must be identical, or the input is refused.
 *
 * Nothing here is a design code or certification: no detail category, S-N constant, strength or size/thickness
 * correction is built in (the calibration carries them, with its source), and no force distribution is inferred:
 * - weld: the force is the resultant carried by the fillet weld group, in-plane and through its centroid, so that the
 *   nominal shear on the stated throat (or leg) area is uniform. Eccentric, out-of-plane, multiaxial, partial
 *   penetration, hot-spot/notch and arbitrary 3D welds are outside this type.
 * - bolt: the force is the total axial force of one bolt (preload plus its share of the external load plus prying), as
 *   determined by the user. An external joint force is refused: its share depends on the preload, the load-introduction
 *   and stiffness factors of the joint (NASA-STD-5020A Eq. 8 and 9), which are not inferred. Compression is refused.
 * Primary sources of the stress definitions (units N, mm, MPa):
 * - DNV-RP-C203 (2005, amended 2006) https://rules.dnv.com/docs/pdf/dnvpm/codes/docs/2006-10/RP-C203.pdf: Table A-2
 *   detail 3 (bolts in tension, stress on the tensile stress area, preload effect from the connection), Table A-8
 *   details 6-7 (fillet welds in shear, stress range from the weld throat area over the total weld length).
 * - NASA-STD-5020A https://www.nasa.gov/wp-content/uploads/2018/01/nasa-std-5020a_w-chg_1_nasa_fastener_standards.pdf:
 *   section 4.4, Eq. 8 (bolt load = preload + n phi x applied load) and Eq. 9 (stiffness factor).
 * - Tensile stress area 0.7854 ((d2 + d3) / 2)^2 per ISO 898-1, as tabulated in
 *   https://crafter.fastenal.com/static-assets/pdfs/Mechanical_Properties_of_Metric_Fasteners.pdf (page 2).
 */
export const FATIGUE_DETAIL_INPUT_SCHEMA = 'pointercad-fatigue-detail/1';
export const FATIGUE_DETAIL_RESULT_SCHEMA = 'pointercad-fatigue-detail-result/1';
/** Joint forces are N; with the smallest areas below, every stress beyond the core's 1e4 MPa bound is refused there. */
export const MAX_FATIGUE_DETAIL_FORCE_N = 1e9;
export const FATIGUE_DETAIL_GEOMETRY_LIMITS = {
  weldSizeMm: { minimum: 0, maximum: 100 },
  weldLengthMm: { minimum: 0, maximum: 10_000 },
  weldLines: { minimum: 1, maximum: 64 },
  boltDiameterMm: { minimum: 1, maximum: 200 },
  /** Largest pitch as a fraction of the nominal diameter (ISO metric coarse threads stay well below). */
  boltPitchToDiameter: 0.25,
} as const;
/**
 * ISO metric basic profile with H = (sqrt(3) / 2) P: d2 = d - (3/4) H and d3 = d - (17/12) H, so the stress diameter
 * (d2 + d3) / 2 = d - (13/12) H = d - (13 sqrt(3) / 24) P = d - 0.938194... P.
 */
export const ISO_METRIC_STRESS_DIAMETER_PITCH_FACTOR = (13 * Math.sqrt(3)) / 24;

export type FatigueDetailKind = 'weld' | 'bolt';
export type FatigueDetailMethod = 'fillet-weld-nominal-shear/1' | 'bolt-axial-nominal/1';
export type FatigueDetailWeldLoadPath = 'concentric-in-plane-shear';
export type FatigueDetailGeometryKind = 'fillet-throat-area' | 'fillet-leg-area' | 'iso-metric-thread-tensile-stress-area'
  | 'nominal-shank-area';
/** Which nominal stress a joint produces and a calibration was derived for. */
export type FatigueDetailStress = 'weld-fillet-throat-nominal-shear' | 'weld-fillet-leg-nominal-shear'
  | 'bolt-axial-normal-tensile-stress-area' | 'bolt-axial-normal-nominal-shank-area';
export type FatigueDetailQuantity = 'weld-group-concentric-shear-force' | 'bolt-total-axial-force' | 'joint-external-axial-force'
  | 'detail-stress';

export type FatigueDetailWeldGeometry =
  | { readonly kind: 'fillet-throat-area'; readonly throatMm: number; readonly effectiveLengthMm: number; readonly lines: number }
  | { readonly kind: 'fillet-leg-area'; readonly legMm: number; readonly effectiveLengthMm: number; readonly lines: number };
export type FatigueDetailBoltGeometry =
  | { readonly kind: 'iso-metric-thread-tensile-stress-area'; readonly nominalDiameterMm: number; readonly pitchMm: number }
  | { readonly kind: 'nominal-shank-area'; readonly nominalDiameterMm: number };
export interface FatigueDetailWeld {
  readonly id: string;
  readonly kind: 'weld';
  readonly method: 'fillet-weld-nominal-shear/1';
  readonly loadPath: FatigueDetailWeldLoadPath;
  readonly geometry: FatigueDetailWeldGeometry;
}
export interface FatigueDetailBolt {
  readonly id: string;
  readonly kind: 'bolt';
  readonly method: 'bolt-axial-nominal/1';
  readonly geometry: FatigueDetailBoltGeometry;
}
export type FatigueDetailJoint = FatigueDetailWeld | FatigueDetailBolt;

/** One chronological joint force history (N), with the same sequence/repeats/source rules as a stress history. */
export interface FatigueDetailForceHistory {
  readonly id: string;
  readonly unit: 'N';
  readonly forceN: readonly number[];
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly source: FatigueSource;
}
export type FatigueDetailLoading =
  | { readonly detailId: string; readonly location: string; readonly quantity: 'weld-group-concentric-shear-force' | 'bolt-total-axial-force';
    readonly histories: readonly FatigueDetailForceHistory[] }
  | { readonly detailId: string; readonly location: string; readonly quantity: 'detail-stress'; readonly stress: FatigueDetailStress;
    readonly histories: readonly FatigueStressHistory[] };
export interface FatigueDetailCurve {
  readonly detailStress: FatigueDetailStress;
  readonly calibration: FatiguePiecewiseCurve;
}
export interface FatigueDetailInput {
  readonly schema: typeof FATIGUE_DETAIL_INPUT_SCHEMA;
  readonly detail: FatigueDetailJoint;
  readonly loading: FatigueDetailLoading;
  readonly curve: FatigueDetailCurve;
}

export type FatigueDetailErrorCode = FatiguePiecewiseErrorCode | 'fatigue-detail-schema' | 'fatigue-detail-kind'
  | 'fatigue-detail-method' | 'fatigue-detail-load-path' | 'fatigue-detail-geometry' | 'fatigue-detail-quantity'
  | 'fatigue-detail-load-distribution' | 'fatigue-detail-bolt-compression' | 'fatigue-detail-stress'
  | 'fatigue-detail-stress-mismatch' | 'fatigue-detail-binding' | 'fatigue-detail-location';
export interface FatigueDetailError { readonly ok: false; readonly code: FatigueDetailErrorCode; readonly path: string }
export interface FatigueDetailChecked {
  readonly input: FatigueDetailInput;
  readonly areaMm2: number;
  readonly detailStress: FatigueDetailStress;
  /** The nominal stress histories (MPa) in the joint's stress definition, as read by the unchanged strict reader. */
  readonly stressInput: FatiguePiecewiseInput;
}
export type FatigueDetailValidation = ({ readonly ok: true } & FatigueDetailChecked) | FatigueDetailError;
export interface FatigueDetailResult {
  readonly schema: typeof FATIGUE_DETAIL_RESULT_SCHEMA;
  readonly method: 'detail-nominal-stress/1+rainflow-three-point-stack/1+miner-linear-piecewise/1';
  readonly scope: 'joint-nominal-stress-uniaxial-linear-damage-estimate';
  readonly codeCompliance: false;
  readonly structuralCertification: false;
  readonly detailId: string;
  readonly detailKind: FatigueDetailKind;
  readonly detailStress: FatigueDetailStress;
  readonly quantity: FatigueDetailLoading['quantity'];
  readonly location: string;
  readonly areaMm2: number;
  readonly stressHistories: readonly FatigueStressHistory[];
  readonly analysis: FatiguePiecewiseResult;
}
export type FatigueDetailAnalysis = { readonly ok: true; readonly result: FatigueDetailResult } | FatigueDetailError;

const DETAIL_STRESSES: readonly FatigueDetailStress[] = ['weld-fillet-throat-nominal-shear', 'weld-fillet-leg-nominal-shear',
  'bolt-axial-normal-tensile-stress-area', 'bolt-axial-normal-nominal-shank-area'];
const QUANTITIES: readonly FatigueDetailQuantity[] = ['weld-group-concentric-shear-force', 'bolt-total-axial-force',
  'joint-external-axial-force', 'detail-stress'];

const fail = (code: FatigueDetailErrorCode, path: string): FatigueDetailError => ({ ok: false, code, path });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const dense = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
};
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isError = (value: object): value is FatigueDetailError => 'ok' in value;
const detailStress = (value: unknown): value is FatigueDetailStress => DETAIL_STRESSES.some(item => item === value);
const quantity = (value: unknown): value is FatigueDetailQuantity => QUANTITIES.some(item => item === value);

/** A positive length in (minimum, maximum] mm. */
function length(value: unknown, path: string, limits: { readonly minimum: number; readonly maximum: number }):
  number | FatigueDetailError {
  if (!finite(value)) return fail('fatigue-number', path);
  if (!(value > limits.minimum && value <= limits.maximum)) return fail('fatigue-detail-geometry', path);
  return value;
}
function lines(value: unknown, path: string): number | FatigueDetailError {
  if (!finite(value)) return fail('fatigue-number', path);
  const { minimum, maximum } = FATIGUE_DETAIL_GEOMETRY_LIMITS.weldLines;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return fail('fatigue-detail-geometry', path);
  return value;
}

function readWeldGeometry(value: unknown): FatigueDetailWeldGeometry | FatigueDetailError {
  const path = 'detail.geometry';
  if (!record(value)) return fail('fatigue-shape', path);
  const kind = value.kind;
  if (kind !== 'fillet-throat-area' && kind !== 'fillet-leg-area') return fail('fatigue-detail-geometry', `${path}.kind`);
  const size = kind === 'fillet-throat-area' ? 'throatMm' : 'legMm';
  if (!exactKeys(value, ['kind', size, 'effectiveLengthMm', 'lines'])) return fail('fatigue-shape', path);
  const sizeMm = length(value[size], `${path}.${size}`, FATIGUE_DETAIL_GEOMETRY_LIMITS.weldSizeMm);
  if (typeof sizeMm !== 'number') return sizeMm;
  const effectiveLengthMm = length(value.effectiveLengthMm, `${path}.effectiveLengthMm`, FATIGUE_DETAIL_GEOMETRY_LIMITS.weldLengthMm);
  if (typeof effectiveLengthMm !== 'number') return effectiveLengthMm;
  const count = lines(value.lines, `${path}.lines`);
  if (typeof count !== 'number') return count;
  return kind === 'fillet-throat-area' ? { kind, throatMm: sizeMm, effectiveLengthMm, lines: count }
    : { kind, legMm: sizeMm, effectiveLengthMm, lines: count };
}

function readBoltGeometry(value: unknown): FatigueDetailBoltGeometry | FatigueDetailError {
  const path = 'detail.geometry';
  if (!record(value)) return fail('fatigue-shape', path);
  const kind = value.kind;
  if (kind !== 'iso-metric-thread-tensile-stress-area' && kind !== 'nominal-shank-area') return fail('fatigue-detail-geometry', `${path}.kind`);
  const keys = kind === 'nominal-shank-area' ? ['kind', 'nominalDiameterMm'] : ['kind', 'nominalDiameterMm', 'pitchMm'];
  if (!exactKeys(value, keys)) return fail('fatigue-shape', path);
  const diameter = value.nominalDiameterMm;
  if (!finite(diameter)) return fail('fatigue-number', `${path}.nominalDiameterMm`);
  const { minimum, maximum } = FATIGUE_DETAIL_GEOMETRY_LIMITS.boltDiameterMm;
  if (diameter < minimum || diameter > maximum) return fail('fatigue-detail-geometry', `${path}.nominalDiameterMm`);
  if (kind === 'nominal-shank-area') return { kind, nominalDiameterMm: diameter };
  const pitch = value.pitchMm;
  if (!finite(pitch)) return fail('fatigue-number', `${path}.pitchMm`);
  if (!(pitch > 0 && pitch <= FATIGUE_DETAIL_GEOMETRY_LIMITS.boltPitchToDiameter * diameter)) return fail('fatigue-detail-geometry', `${path}.pitchMm`);
  return { kind, nominalDiameterMm: diameter, pitchMm: pitch };
}

function readDetail(value: unknown): FatigueDetailJoint | FatigueDetailError {
  if (!record(value)) return fail('fatigue-shape', 'detail');
  const kind = value.kind;
  if (kind !== 'weld' && kind !== 'bolt') return fail('fatigue-detail-kind', 'detail.kind');
  if (!exactKeys(value, kind === 'weld' ? ['id', 'kind', 'method', 'loadPath', 'geometry'] : ['id', 'kind', 'method', 'geometry'])) {
    return fail('fatigue-shape', 'detail');
  }
  if (!text(value.id, 64)) return fail('fatigue-id', 'detail.id');
  const id = value.id;
  if (kind === 'weld') {
    if (value.method !== 'fillet-weld-nominal-shear/1') return fail('fatigue-detail-method', 'detail.method');
    if (value.loadPath !== 'concentric-in-plane-shear') return fail('fatigue-detail-load-path', 'detail.loadPath');
    const geometry = readWeldGeometry(value.geometry);
    if (isError(geometry)) return geometry;
    return { id, kind, method: 'fillet-weld-nominal-shear/1', loadPath: 'concentric-in-plane-shear', geometry };
  }
  if (value.method !== 'bolt-axial-nominal/1') return fail('fatigue-detail-method', 'detail.method');
  const geometry = readBoltGeometry(value.geometry);
  if (isError(geometry)) return geometry;
  return { id, kind, method: 'bolt-axial-nominal/1', geometry };
}

/** The nominal stress definition a validated joint produces. */
export function fatigueDetailStressDefinition(detail: FatigueDetailJoint): FatigueDetailStress {
  switch (detail.geometry.kind) {
    case 'fillet-throat-area': return 'weld-fillet-throat-nominal-shear';
    case 'fillet-leg-area': return 'weld-fillet-leg-nominal-shear';
    case 'iso-metric-thread-tensile-stress-area': return 'bolt-axial-normal-tensile-stress-area';
    case 'nominal-shank-area': return 'bolt-axial-normal-nominal-shank-area';
  }
}

/** The area (mm2) on which a validated joint's nominal stress is defined. */
export function fatigueDetailAreaMm2(detail: FatigueDetailJoint): number {
  const geometry = detail.geometry;
  switch (geometry.kind) {
    case 'fillet-throat-area': return geometry.lines * geometry.throatMm * geometry.effectiveLengthMm;
    case 'fillet-leg-area': return geometry.lines * geometry.legMm * geometry.effectiveLengthMm;
    case 'iso-metric-thread-tensile-stress-area': {
      const stressDiameter = geometry.nominalDiameterMm - ISO_METRIC_STRESS_DIAMETER_PITCH_FACTOR * geometry.pitchMm;
      return (Math.PI / 4) * stressDiameter * stressDiameter;
    }
    case 'nominal-shank-area': return (Math.PI / 4) * geometry.nominalDiameterMm * geometry.nominalDiameterMm;
  }
}

/** Which loading quantities a joint accepts; the refusal names why the others are not converted. */
function acceptQuantity(detail: FatigueDetailJoint, value: FatigueDetailQuantity): FatigueDetailError | null {
  if (value === 'detail-stress') return null;
  if (detail.kind === 'weld') return value === 'weld-group-concentric-shear-force' ? null : fail('fatigue-detail-quantity', 'loading.quantity');
  if (value === 'bolt-total-axial-force') return null;
  // The bolt's share of an external force needs the preload and the joint's load-introduction and stiffness factors.
  return fail(value === 'joint-external-axial-force' ? 'fatigue-detail-load-distribution' : 'fatigue-detail-quantity', 'loading.quantity');
}

interface RawLoading {
  readonly detailId: string;
  readonly location: string;
  readonly quantity: FatigueDetailQuantity;
  readonly stress: FatigueDetailStress | null;
  /** Rows for the strict stress-history reader: converted force rows, or the user's stress rows unchanged. */
  readonly stressRows: readonly unknown[];
  readonly forceN: readonly (readonly number[])[] | null;
}

function readForceRow(value: unknown, path: string, detail: FatigueDetailJoint, areaMm2: number):
  { readonly forceN: number[]; readonly row: Record<string, unknown> } | FatigueDetailError {
  if (!record(value) || !exactKeys(value, ['id', 'unit', 'forceN', 'sequence', 'repeats', 'source'])) return fail('fatigue-shape', path);
  if (value.unit !== 'N') return fail('fatigue-unit', `${path}.unit`);
  const points = value.forceN;
  if (!dense(points)) return fail('fatigue-shape', `${path}.forceN`);
  if (points.length < 1 || points.length > MAX_FATIGUE_HISTORY_POINTS) return fail('fatigue-history', `${path}.forceN`);
  const forceN: number[] = [], stressMpa: number[] = [];
  for (const [index, point] of points.entries()) {
    if (!finite(point)) return fail('fatigue-number', `${path}.forceN[${index}]`);
    if (Math.abs(point) > MAX_FATIGUE_DETAIL_FORCE_N) return fail('fatigue-bound', `${path}.forceN[${index}]`);
    if (detail.kind === 'bolt' && point < 0) return fail('fatigue-detail-bolt-compression', `${path}.forceN[${index}]`);
    forceN.push(point);
    // N / mm2 = MPa.
    stressMpa.push(point / areaMm2);
  }
  return { forceN, row: { id: value.id, unit: 'MPa', stressMpa, sequence: value.sequence, repeats: value.repeats, source: value.source } };
}

function readLoading(value: unknown, detail: FatigueDetailJoint, areaMm2: number): RawLoading | FatigueDetailError {
  if (!record(value)) return fail('fatigue-shape', 'loading');
  const kind = value.quantity;
  if (!quantity(kind)) return fail('fatigue-detail-quantity', 'loading.quantity');
  if (!exactKeys(value, kind === 'detail-stress' ? ['detailId', 'location', 'quantity', 'stress', 'histories']
    : ['detailId', 'location', 'quantity', 'histories'])) return fail('fatigue-shape', 'loading');
  if (!text(value.detailId, 64)) return fail('fatigue-id', 'loading.detailId');
  if (!text(value.location, 512)) return fail('fatigue-detail-location', 'loading.location');
  const refused = acceptQuantity(detail, kind);
  if (refused !== null) return refused;
  let stress: FatigueDetailStress | null = null;
  if (kind === 'detail-stress') {
    if (!detailStress(value.stress)) return fail('fatigue-detail-stress', 'loading.stress');
    stress = value.stress;
  }
  const rows = value.histories;
  if (!dense(rows)) return fail('fatigue-shape', 'loading.histories');
  if (rows.length < 1 || rows.length > MAX_FATIGUE_HISTORIES) return fail('fatigue-history', 'loading.histories');
  if (kind === 'detail-stress') {
    return { detailId: value.detailId, location: value.location, quantity: kind, stress, stressRows: rows, forceN: null };
  }
  const stressRows: Record<string, unknown>[] = [], forces: number[][] = [];
  for (const [index, row] of rows.entries()) {
    const read = readForceRow(row, `loading.histories[${index}]`, detail, areaMm2);
    if (isError(read)) return read;
    stressRows.push(read.row);
    forces.push(read.forceN);
  }
  return { detailId: value.detailId, location: value.location, quantity: kind, stress, stressRows, forceN: forces };
}

/** Paths of the unchanged piecewise reader/analysis, mapped back to where the value stands in the detail input. */
function mapPath(path: string, force: boolean): string {
  if (path === 'curve' || path.startsWith('curve.')) return `curve.calibration${path.slice('curve'.length)}`;
  if (path.startsWith('histories')) {
    const mapped = `loading.${path}`;
    return force ? mapped.replace(/^(loading\.histories\[\d+\])\.stressMpa/, '$1.forceN') : mapped;
  }
  return path;
}
const mapError = (error: FatiguePiecewiseError, force: boolean): FatigueDetailError => fail(error.code, mapPath(error.path, force));

/**
 * Strict reader of unknown data; returns fresh values (later caller mutation cannot change an analysis). The joint, the
 * loading and the curve must name the same stress definition; the curve and stress histories are read by the unchanged
 * validateFatiguePiecewiseInput.
 */
export function validateFatigueDetailInput(value: unknown): FatigueDetailValidation {
  if (!record(value) || !exactKeys(value, ['schema', 'detail', 'loading', 'curve'])) return fail('fatigue-shape', '$');
  if (value.schema !== FATIGUE_DETAIL_INPUT_SCHEMA) return fail('fatigue-detail-schema', 'schema');
  const detail = readDetail(value.detail);
  if (isError(detail)) return detail;
  const areaMm2 = fatigueDetailAreaMm2(detail);
  // Each positive dimension is in range, yet their product can underflow (1e-200 mm x 1e-200 mm is 0 mm2).
  if (!(Number.isFinite(areaMm2) && areaMm2 > 0)) return fail('fatigue-detail-geometry', 'detail.geometry');
  const derived = fatigueDetailStressDefinition(detail);
  const curve = value.curve;
  if (!record(curve) || !exactKeys(curve, ['detailStress', 'calibration'])) return fail('fatigue-shape', 'curve');
  if (!detailStress(curve.detailStress)) return fail('fatigue-detail-stress', 'curve.detailStress');
  const loading = readLoading(value.loading, detail, areaMm2);
  if (isError(loading)) return loading;
  if (loading.detailId !== detail.id) return fail('fatigue-detail-binding', 'loading.detailId');
  if (loading.stress !== null && loading.stress !== derived) return fail('fatigue-detail-stress-mismatch', 'loading.stress');
  // A calibration derived for another stress (e.g. tensile stress area vs. shank area) is never applied.
  if (curve.detailStress !== derived) return fail('fatigue-detail-stress-mismatch', 'curve.detailStress');
  const force = loading.forceN !== null;
  const checked = validateFatiguePiecewiseInput({ schema: FATIGUE_PIECEWISE_INPUT_SCHEMA, curve: curve.calibration, histories: loading.stressRows });
  if (!checked.ok) return mapError(checked, force);
  const stressInput = checked.input;
  if (detail.kind === 'bolt') {
    for (const [at, history] of stressInput.histories.entries()) {
      const index = history.stressMpa.findIndex(stress => stress < 0);
      if (index >= 0) return fail('fatigue-detail-bolt-compression', `loading.histories[${at}].${force ? 'forceN' : 'stressMpa'}[${index}]`);
    }
  }
  const base = { detailId: loading.detailId, location: loading.location };
  const forces = loading.forceN;
  let read: FatigueDetailLoading;
  if (forces === null) {
    if (loading.stress === null) return fail('fatigue-detail-stress', 'loading.stress');
    read = { ...base, quantity: 'detail-stress', stress: loading.stress, histories: stressInput.histories };
  } else {
    if (loading.quantity !== 'weld-group-concentric-shear-force' && loading.quantity !== 'bolt-total-axial-force') {
      return fail('fatigue-detail-quantity', 'loading.quantity');
    }
    const histories = stressInput.histories.map((history, at): FatigueDetailForceHistory => ({ id: history.id, unit: 'N',
      forceN: [...(forces[at] ?? [])], sequence: history.sequence, repeats: history.repeats,
      source: { ...history.source } }));
    read = { ...base, quantity: loading.quantity, histories };
  }
  return { ok: true, input: { schema: FATIGUE_DETAIL_INPUT_SCHEMA, detail, loading: read,
    curve: { detailStress: derived, calibration: stressInput.curve } }, areaMm2, detailStress: derived, stressInput };
}

/** Validates unknown input, converts the joint force to its nominal stress and runs the unchanged piecewise analysis. */
export function analyzeFatigueDetail(value: unknown): FatigueDetailAnalysis {
  const checked = validateFatigueDetailInput(value);
  if (!checked.ok) return checked;
  const { input, areaMm2, detailStress: stress, stressInput } = checked;
  const analyzed = analyzeFatiguePiecewise(stressInput);
  if (!analyzed.ok) return mapError(analyzed, input.loading.quantity !== 'detail-stress');
  return { ok: true, result: { schema: FATIGUE_DETAIL_RESULT_SCHEMA,
    method: 'detail-nominal-stress/1+rainflow-three-point-stack/1+miner-linear-piecewise/1',
    scope: 'joint-nominal-stress-uniaxial-linear-damage-estimate', codeCompliance: false, structuralCertification: false,
    detailId: input.detail.id, detailKind: input.detail.kind, detailStress: stress, quantity: input.loading.quantity,
    location: input.loading.location, areaMm2, stressHistories: stressInput.histories, analysis: analyzed.result } };
}
