import { InputIssue, text } from './analysisValidation.js';
import { FATIGUE_SAVED_ID, FATIGUE_SAVED_LIMITS, denseFatigueList, exactFatigueFields, fatigueLabel,
  finiteFatigueNumber, type FatigueSavedHistory, type FatigueSavedSource } from './fatigueInput.js';
import { readFatiguePiecewiseSavedProblem, type FatigueSavedPiecewiseCurve } from './fatiguePiecewiseInput.js';

/** Input only; no derived area, stress, damage or life is persisted. Versions 1–5 are unchanged. */
export const FATIGUE_SAVED_DETAIL_SCHEMA = 'pointercad-fatigue-saved/6';
export const FATIGUE_SAVED_DETAIL_INPUT_SCHEMA = 'pointercad-fatigue-detail/1';
export type FatigueSavedDetailStress = 'weld-fillet-throat-nominal-shear' | 'weld-fillet-leg-nominal-shear'
  | 'bolt-axial-normal-tensile-stress-area' | 'bolt-axial-normal-nominal-shank-area';
export type FatigueSavedDetailJoint = {
  readonly id: string;
  readonly kind: 'weld';
  readonly method: 'fillet-weld-nominal-shear/1';
  readonly loadPath: 'concentric-in-plane-shear';
  readonly geometry: { readonly kind: 'fillet-throat-area'; readonly throatMm: number;
    readonly effectiveLengthMm: number; readonly lines: number } | { readonly kind: 'fillet-leg-area';
    readonly legMm: number; readonly effectiveLengthMm: number; readonly lines: number };
} | {
  readonly id: string;
  readonly kind: 'bolt';
  readonly method: 'bolt-axial-nominal/1';
  readonly geometry: { readonly kind: 'iso-metric-thread-tensile-stress-area'; readonly nominalDiameterMm: number;
    readonly pitchMm: number } | { readonly kind: 'nominal-shank-area'; readonly nominalDiameterMm: number };
};
export interface FatigueSavedDetailForceHistory {
  readonly id: string;
  readonly unit: 'N';
  readonly forceN: readonly number[];
  readonly sequence: 'once' | 'repeated-periodic';
  readonly repeats: number;
  readonly source: FatigueSavedSource;
}
export type FatigueSavedDetailLoading = {
  readonly detailId: string; readonly location: string;
} & ({ readonly quantity: 'weld-group-concentric-shear-force' | 'bolt-total-axial-force';
  readonly histories: readonly FatigueSavedDetailForceHistory[] }
  | { readonly quantity: 'detail-stress'; readonly stress: FatigueSavedDetailStress;
    readonly histories: readonly FatigueSavedHistory[] });
export interface FatigueSavedDetailProblem {
  readonly schema: typeof FATIGUE_SAVED_DETAIL_INPUT_SCHEMA;
  readonly detail: FatigueSavedDetailJoint;
  readonly loading: FatigueSavedDetailLoading;
  readonly curve: { readonly detailStress: FatigueSavedDetailStress; readonly calibration: FatigueSavedPiecewiseCurve };
}
export interface FatigueDetailSavedInput {
  readonly schema: typeof FATIGUE_SAVED_DETAIL_SCHEMA;
  readonly id: typeof FATIGUE_SAVED_ID;
  readonly source: { readonly documentId: string };
  readonly input: FatigueSavedDetailProblem;
}

function fail(path: string, message: string): never {
  throw new InputIssue('fatigue', path, message);
}
/** Inspect descriptors before any shared reader reads a property. Never invoke an input accessor. */
function checkData(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { finiteFatigueNumber(value, path); return; }
  if (typeof value !== 'object') fail(path, 'Expected JSON data');
  if (ancestors.has(value)) fail(path, 'Cyclic input');
  if (ancestors.size >= 32) fail(path, 'Input nesting is unsupported');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail(path, 'Expected a plain input record');
  }
  if (array && value.length > FATIGUE_SAVED_LIMITS.maximumPoints) fail(path, 'Input list is too large');
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) fail(path, 'Expected a dense list with no extra fields');
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') fail(path, 'Symbol fields are not saved data');
    const at = array ? `${path}[${key}]` : `${path}.${key}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) fail(at, 'Expected an enumerable data field');
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail(at, 'Invalid list index');
    checkData(descriptor.value, at, ancestors);
  }
  ancestors.delete(value);
}
function positive(value: unknown, path: string, maximum: number): number {
  const number = finiteFatigueNumber(value, path);
  if (!(number > 0 && number <= maximum)) fail(path, `Expected 0 < value <= ${maximum}`);
  return number;
}
function joint(value: unknown, path: string): FatigueSavedDetailJoint {
  const base = exactFatigueFields(value, value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'weld'
    ? ['id', 'kind', 'method', 'geometry', 'loadPath'] : ['id', 'kind', 'method', 'geometry'], path);
  const id = fatigueLabel(base.id, `${path}.id`, 64);
  if (base.kind === 'weld') {
    if (base.method !== 'fillet-weld-nominal-shear/1') fail(`${path}.method`, 'Expected nominal fillet shear method');
    if (base.loadPath !== 'concentric-in-plane-shear') fail(`${path}.loadPath`, 'Expected explicit concentric in-plane shear');
    const throat = base.geometry !== null && typeof base.geometry === 'object' && 'kind' in base.geometry
      && base.geometry.kind === 'fillet-throat-area';
    const size = throat ? 'throatMm' : 'legMm';
    const g = exactFatigueFields(base.geometry, ['kind', size, 'effectiveLengthMm', 'lines'], `${path}.geometry`);
    if (g.kind !== 'fillet-throat-area' && g.kind !== 'fillet-leg-area') fail(`${path}.geometry.kind`, 'Unsupported weld area');
    const sizeMm = positive(g[size], `${path}.geometry.${size}`, 100);
    const effectiveLengthMm = positive(g.effectiveLengthMm, `${path}.geometry.effectiveLengthMm`, 10000);
    const lines = finiteFatigueNumber(g.lines, `${path}.geometry.lines`);
    if (!Number.isInteger(lines) || lines < 1 || lines > 64) fail(`${path}.geometry.lines`, 'Expected 1 to 64 weld lines');
    return { id, kind: 'weld', method: base.method, loadPath: base.loadPath,
      geometry: g.kind === 'fillet-throat-area' ? { kind: g.kind, throatMm: sizeMm, effectiveLengthMm, lines }
        : { kind: g.kind, legMm: sizeMm, effectiveLengthMm, lines } };
  }
  if (base.kind !== 'bolt') fail(`${path}.kind`, 'Expected weld or bolt');
  if (base.method !== 'bolt-axial-nominal/1') fail(`${path}.method`, 'Expected nominal bolt axial method');
  const threaded = base.geometry !== null && typeof base.geometry === 'object' && 'kind' in base.geometry
    && base.geometry.kind === 'iso-metric-thread-tensile-stress-area';
  const g = exactFatigueFields(base.geometry, threaded ? ['kind', 'nominalDiameterMm', 'pitchMm'] : ['kind', 'nominalDiameterMm'], `${path}.geometry`);
  const nominalDiameterMm = positive(g.nominalDiameterMm, `${path}.geometry.nominalDiameterMm`, 200);
  if (nominalDiameterMm < 1) fail(`${path}.geometry.nominalDiameterMm`, 'Expected diameter >= 1 mm');
  if (g.kind === 'iso-metric-thread-tensile-stress-area') {
    const pitchMm = positive(g.pitchMm, `${path}.geometry.pitchMm`, 0.25 * nominalDiameterMm);
    return { id, kind: 'bolt', method: base.method, geometry: { kind: g.kind, nominalDiameterMm, pitchMm } };
  }
  if (g.kind !== 'nominal-shank-area') fail(`${path}.geometry.kind`, 'Unsupported bolt area');
  return { id, kind: 'bolt', method: base.method, geometry: { kind: g.kind, nominalDiameterMm } };
}
function areaAndStress(detail: FatigueSavedDetailJoint): { area: number; stress: FatigueSavedDetailStress } {
  const g = detail.geometry;
  if (g.kind === 'fillet-throat-area' || g.kind === 'fillet-leg-area') {
    return { area: g.lines * (g.kind === 'fillet-throat-area' ? g.throatMm : g.legMm) * g.effectiveLengthMm,
      stress: g.kind === 'fillet-throat-area' ? 'weld-fillet-throat-nominal-shear' : 'weld-fillet-leg-nominal-shear' };
  }
  const threaded = g.kind === 'iso-metric-thread-tensile-stress-area';
  // ISO basic-profile stress diameter: d - (13 sqrt(3) / 24) P. Root input-contract decision.
  return { area: Math.PI / 4 * (g.nominalDiameterMm - (threaded ? (13 * Math.sqrt(3) / 24) * g.pitchMm : 0)) ** 2,
    stress: threaded ? 'bolt-axial-normal-tensile-stress-area' : 'bolt-axial-normal-nominal-shank-area' };
}
function problem(value: unknown, path: string): FatigueSavedDetailProblem {
  const row = exactFatigueFields(value, ['schema', 'detail', 'loading', 'curve'], path);
  if (row.schema !== FATIGUE_SAVED_DETAIL_INPUT_SCHEMA) fail(`${path}.schema`, 'Expected detail fatigue input schema 1');
  const detail = joint(row.detail, `${path}.detail`);
  const derived = areaAndStress(detail);
  if (!(Number.isFinite(derived.area) && derived.area > 0)) fail(`${path}.detail.geometry`, 'Derived detail area must be finite and positive');
  const c = exactFatigueFields(row.curve, ['detailStress', 'calibration'], `${path}.curve`);
  if (c.detailStress !== derived.stress) fail(`${path}.curve.detailStress`, 'Curve stress definition must match the selected area');
  const isStress = row.loading !== null && typeof row.loading === 'object' && 'quantity' in row.loading && row.loading.quantity === 'detail-stress';
  const loading = exactFatigueFields(row.loading, ['detailId', 'location', 'quantity', 'histories', ...(isStress ? ['stress'] : [])], `${path}.loading`);
  if (loading.detailId !== detail.id) fail(`${path}.loading.detailId`, 'Loading must reference this detail');
  const location = fatigueLabel(loading.location, `${path}.loading.location`, 512);
  const quantity = loading.quantity;
  if (quantity !== 'detail-stress' && quantity !== 'weld-group-concentric-shear-force' && quantity !== 'bolt-total-axial-force'
    && quantity !== 'joint-external-axial-force') fail(`${path}.loading.quantity`, 'Unsupported quantity');
  if (quantity === 'joint-external-axial-force') fail(`${path}.loading.quantity`, 'Joint external force is not the total bolt force; distribution is not inferred');
  if (quantity !== 'detail-stress' && quantity !== (detail.kind === 'weld' ? 'weld-group-concentric-shear-force' : 'bolt-total-axial-force')) {
    fail(`${path}.loading.quantity`, 'Quantity does not match this detail');
  }
  if (isStress && loading.stress !== derived.stress) fail(`${path}.loading.stress`, 'Loading stress definition must match the selected area and curve');
  const histories = denseFatigueList(loading.histories, `${path}.loading.histories`);
  const forceRows = isStress ? [] : histories.map((item, index) => {
    const at = `${path}.loading.histories[${index}]`;
    const h = exactFatigueFields(item, ['id', 'unit', 'forceN', 'sequence', 'repeats', 'source'], at);
    if (h.unit !== 'N') fail(`${at}.unit`, 'Expected N');
    const forceN = denseFatigueList(h.forceN, `${at}.forceN`).map((item, j) => {
      const force = finiteFatigueNumber(item, `${at}.forceN[${j}]`);
      if (Math.abs(force) > 1e9) fail(`${at}.forceN[${j}]`, 'Expected |force| <= 1e9 N');
      if (detail.kind === 'bolt' && force < 0) fail(`${at}.forceN[${j}]`, 'Bolt compression is unsupported');
      return force;
    });
    return { h, forceN };
  });
  const converted = isStress ? histories : forceRows.map(({ h, forceN }) => ({ id: h.id, unit: 'MPa',
    stressMpa: forceN.map(force => force / derived.area), sequence: h.sequence, repeats: h.repeats, source: h.source }));
  // Reuse the existing curve/history reader unchanged, including point limits, repeats, source and duplicate ids.
  let read;
  try {
    read = readFatiguePiecewiseSavedProblem({ schema: 'pointercad-fatigue-piecewise/1', curve: c.calibration, histories: converted }, path);
  } catch (error) {
    if (!(error instanceof InputIssue)) throw error;
    let actual = error.path.replace(`${path}.curve`, `${path}.curve.calibration`).replace(`${path}.histories`, `${path}.loading.histories`);
    if (!isStress) actual = actual.replace('.stressMpa', '.forceN');
    throw new InputIssue(error.code, actual, error.message);
  }
  const common = { detailId: detail.id, location };
  const curve = { detailStress: derived.stress, calibration: read.curve };
  if (detail.kind === 'bolt') {
    for (const [i, history] of read.histories.entries()) {
      const index = history.stressMpa.findIndex(stress => stress < 0);
      if (index >= 0) fail(`${path}.loading.histories[${i}].${isStress ? 'stressMpa' : 'forceN'}[${index}]`, 'Bolt compression is unsupported');
    }
  }
  if (quantity === 'detail-stress') return { schema: FATIGUE_SAVED_DETAIL_INPUT_SCHEMA, detail, curve,
    loading: { ...common, quantity, stress: derived.stress, histories: read.histories } };
  return { schema: FATIGUE_SAVED_DETAIL_INPUT_SCHEMA, detail, curve, loading: { ...common, quantity,
    histories: read.histories.map((history, i): FatigueSavedDetailForceHistory => ({ id: history.id, unit: 'N',
      forceN: forceRows[i].forceN, sequence: history.sequence, repeats: history.repeats, source: history.source })) } };
}

/** Contract §§2,6. Bounds describe supported input, not a code-certified dimension catalogue. */
export function readFatigueDetailSavedProblem(value: unknown, path = 'input'): FatigueSavedDetailProblem {
  checkData(value, path);
  return problem(value, path);
}
/** Reads only schema 6; old readers and the shared saved-analysis union are intentionally untouched. */
export function readFatigueDetailSavedInput(value: unknown, path = 'definition'): FatigueDetailSavedInput {
  checkData(value, path);
  const row = exactFatigueFields(value, ['schema', 'id', 'source', 'input'], path);
  if (row.schema !== FATIGUE_SAVED_DETAIL_SCHEMA) throw new InputIssue('unsupported-model', path, 'Expected saved fatigue schema 6');
  if (row.id !== FATIGUE_SAVED_ID) fail(`${path}.id`, 'Unexpected fatigue input id');
  const source = exactFatigueFields(row.source, ['documentId'], `${path}.source`);
  return { schema: FATIGUE_SAVED_DETAIL_SCHEMA, id: FATIGUE_SAVED_ID,
    source: { documentId: text(source.documentId, `${path}.source.documentId`) }, input: problem(row.input, `${path}.input`) };
}
