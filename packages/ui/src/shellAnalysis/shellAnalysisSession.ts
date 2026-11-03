import { SHELL_LIMITS, type CadShellAnalysisResult } from '@pointercad/fem';
import type { Parameter } from '@pointercad/model';
import { readShellCadAnalysisInput, SHELL_CAD_ANALYSIS_SCHEMA, SHELL_CAD_SCHEMA,
  type ShellCadAnalysisInput } from '@pointercad/model/beam-analysis';
import { plasticBarExpressionField } from '../beam/beamFields.js';
import { t, type MessageKey } from '../i18n/t.js';

/**
 * Screen draft of one thin-sheet (shell) analysis: explicit midsurface faces of one CAD sheet body, thickness and
 * offset, material E/nu with its source, six-DOF supports on CAD edges/vertices and uniform edge force/moment.
 * Nothing physical is defaulted: material, its source, every fixed flag and every load component start empty and
 * must be entered. Only the meshing tolerances start with shown, editable values (they choose the mesh, not physics).
 */
export const SHELL_FIELDS = ['thickness', 'offset', 'young', 'poisson', 'linear', 'angular', 'minimumArea',
  'minimumAngle', 'maximumAspect'] as const;
export type ShellField = typeof SHELL_FIELDS[number];
export const SHELL_LOAD_COMPONENTS = ['fx', 'fy', 'fz', 'mx', 'my', 'mz'] as const;
export type ShellLoadComponent = typeof SHELL_LOAD_COMPONENTS[number];
export const SHELL_DOFS = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const;
export type ShellDof = typeof SHELL_DOFS[number];
export type ShellFixedDraft = readonly [boolean, boolean, boolean, boolean, boolean, boolean];
type SupportOrigin = ShellCadAnalysisInput['supports'][number]['origin'];
type EdgeOrigin = ShellCadAnalysisInput['edgeLoads'][number]['origin'];
export type ShellMaterialSourceKind = ShellCadAnalysisInput['material']['source']['kind'];
export const SHELL_MATERIAL_SOURCE_KINDS: readonly ShellMaterialSourceKind[] = ['user-supplied', 'measured', 'published'];

export interface ShellSupportDraft {
  readonly key: string;
  readonly kind: 'edge' | 'vertex';
  readonly origin: SupportOrigin;
  readonly fixed: ShellFixedDraft;
}
export interface ShellEdgeLoadDraft {
  readonly key: string;
  readonly origin: EdgeOrigin;
  readonly values: Readonly<Record<ShellLoadComponent, string>>;
}
export interface ShellMaterialSourceDraft {
  readonly kind: ShellMaterialSourceKind | null;
  readonly reference: string;
  readonly condition: string;
}
/** Result view choice: display only, never part of the input, the request or the saved definition. */
export type ShellStressComponent = 'xx' | 'yy' | 'zz' | 'yz' | 'xz' | 'xy';
export const SHELL_STRESS_COMPONENTS: readonly ShellStressComponent[] = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];

export interface ShellAnalysisSession {
  readonly ownerId: string;
  /** Advances on every physical edit; a reply is accepted only for the revision it was requested with. */
  readonly revision: number;
  readonly bodyFeatureId: string | null;
  /** solidCadFaceKey keys of the explicit midsurface faces (the same keys as the saved shell-cad geometry). */
  readonly midsurfaceFaces: readonly string[];
  readonly supports: readonly ShellSupportDraft[];
  readonly edgeLoads: readonly ShellEdgeLoadDraft[];
  readonly values: Readonly<Record<ShellField, string>>;
  readonly materialSource: ShellMaterialSourceDraft;
  /** Saved values the screen has no field for. Read from the saved definition and written back exactly as read, so a
   * load -> edit -> save never changes them; a new draft starts with the existing defaults. No edit action sets them. */
  readonly kept: { readonly materialId: string; readonly maximumNodes: number; readonly maximumTriangles: number };
  readonly focused: string | null;
  readonly status: 'editing' | 'running' | 'complete' | 'failed' | 'cancelled';
  readonly error: string | null;
  readonly result: CadShellAnalysisResult | null;
  readonly view: { readonly component: ShellStressComponent };
}

/** Draft identity of a captured support/load row (duplicate check and React key): canonical, key-sorted JSON of its
 * semantic origin. Binding to the current shape is NOT done here but by the fem resolveSavedCadShellSettings. */
export function shellOriginKey(origin: SupportOrigin): string {
  return JSON.stringify(origin, (_key: string, value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

const EMPTY_LOAD: Readonly<Record<ShellLoadComponent, string>> = { fx: '', fy: '', fz: '', mx: '', my: '', mz: '' };
export function emptyShellLoadValues(): Readonly<Record<ShellLoadComponent, string>> { return { ...EMPTY_LOAD }; }
/** A newly added support fixes nothing: the user ticks every restrained degree of freedom explicitly. */
export function emptyShellFixed(): ShellFixedDraft { return [false, false, false, false, false, false]; }

export function createShellAnalysisSession(ownerId: string, saved?: ShellCadAnalysisInput): ShellAnalysisSession {
  const base = { ownerId, revision: 0, focused: null, status: 'editing' as const, error: null, result: null,
    view: { component: 'xx' as const } };
  if (saved === undefined) {
    return { ...base, bodyFeatureId: null, midsurfaceFaces: [], supports: [], edgeLoads: [],
      materialSource: { kind: null, reference: '', condition: '' },
      kept: { materialId: 'material', maximumNodes: SHELL_LIMITS.nodes, maximumTriangles: SHELL_LIMITS.elements },
      values: { thickness: '', offset: '0', young: '', poisson: '', linear: '0.1', angular: '0.3', minimumArea: '0',
        minimumAngle: '20', maximumAspect: '4' } };
  }
  const read = readShellCadAnalysisInput(saved);
  return { ...base, bodyFeatureId: read.geometry.bodyFeatureId, midsurfaceFaces: [...read.geometry.midsurfaceFaces],
    supports: read.supports.map(row => ({ key: shellOriginKey(row.origin), kind: row.kind, origin: structuredClone(row.origin),
      fixed: [...row.fixed] })),
    edgeLoads: read.edgeLoads.map(row => ({ key: shellOriginKey(row.origin), origin: structuredClone(row.origin),
      values: { fx: String(row.forceNPerMm[0]), fy: String(row.forceNPerMm[1]), fz: String(row.forceNPerMm[2]),
        mx: String(row.momentNmmPerMm[0]), my: String(row.momentNmmPerMm[1]), mz: String(row.momentNmmPerMm[2]) } })),
    materialSource: { ...read.material.source },
    kept: { materialId: read.material.id, maximumNodes: read.surface.maximumNodes,
      maximumTriangles: read.surface.maximumTriangles },
    values: { thickness: String(read.geometry.thicknessMm), offset: String(read.geometry.offsetMm),
      young: String(read.material.youngMPa), poisson: String(read.material.poisson),
      linear: String(read.surface.linearDeflection), angular: String(read.surface.angularDeflection),
      minimumArea: String(read.surface.minimumTriangleAreaMm2), minimumAngle: String(read.surface.minimumAngleDeg),
      maximumAspect: String(read.surface.maximumAspectRatio) } };
}

const FIELD_LABELS: Readonly<Record<ShellField, MessageKey>> = {
  thickness: 'shellAnalysis.thickness', offset: 'shellAnalysis.offset', young: 'shellAnalysis.young',
  poisson: 'shellAnalysis.poisson', linear: 'shellAnalysis.linear', angular: 'shellAnalysis.angular',
  minimumArea: 'shellAnalysis.minimumArea', minimumAngle: 'shellAnalysis.minimumAngle', maximumAspect: 'shellAnalysis.maximumAspect',
};
const LOAD_LABELS: Readonly<Record<ShellLoadComponent, MessageKey>> = {
  fx: 'shellAnalysis.loadFx', fy: 'shellAnalysis.loadFy', fz: 'shellAnalysis.loadFz',
  mx: 'shellAnalysis.loadMx', my: 'shellAnalysis.loadMy', mz: 'shellAnalysis.loadMz',
};
const FIELD_UNITS: Readonly<Record<ShellField, string>> = {
  thickness: 'mm', offset: 'mm', young: 'MPa', poisson: '—', linear: 'mm', angular: 'rad', minimumArea: 'mm²',
  minimumAngle: '°', maximumAspect: '—',
};

/** The existing expression/unit/parameter parser and IME-capable field (the same one the solid analysis uses).
 * Positive length: thickness; signed length: offset; positive stress: E; plain signed numbers: the others. */
export function shellExpressionField(name: ShellField, source: string, parameters: readonly Parameter[]):
  ReturnType<typeof plasticBarExpressionField> {
  const kind = name === 'thickness' ? 'length' : name === 'offset' || name === 'linear' ? 'knot'
    : name === 'young' ? 'young' : 'poisson';
  const field = plasticBarExpressionField(kind, `shell-${name}`, source, parameters);
  return { ...field, field: { ...field.field, labelKey: FIELD_LABELS[name], tooltipKey: 'shellAnalysis.expressionHelp' },
    unitLabel: FIELD_UNITS[name] };
}
/** Signed plain numbers: force per unit edge length [N/mm] and moment per unit edge length [N·mm/mm], global axes. */
export function shellLoadExpressionField(edgeKey: string, component: ShellLoadComponent, source: string,
  parameters: readonly Parameter[]): ReturnType<typeof plasticBarExpressionField> {
  const field = plasticBarExpressionField('poisson', `shell-load-${component}-${edgeKey}`, source, parameters);
  return { ...field, field: { ...field.field, labelKey: LOAD_LABELS[component], tooltipKey: 'shellAnalysis.loadHelp' },
    unitLabel: component.startsWith('f') ? 'N/mm' : 'N·mm/mm' };
}

function evaluated(result: ReturnType<typeof plasticBarExpressionField>['result']): number {
  if (result.value === null) throw new Error(result.error?.message ?? t('shellAnalysis.invalidNumber'));
  const value = result.value.value;
  if (!Number.isFinite(value)) throw new Error(t('shellAnalysis.invalidNumber'));
  return value;
}

/** The complete saved definition (Terra's pointercad-shell-cad-analysis/1), checked by its own reader. Throws with a
 * Japanese reason when something is missing; never fills a missing value. */
export function shellSavedInput(session: ShellAnalysisSession, documentId: string,
  parameters: readonly Parameter[]): ShellCadAnalysisInput {
  if (session.bodyFeatureId === null || session.midsurfaceFaces.length === 0) throw new Error(t('shellAnalysis.needMidsurface'));
  if (session.supports.length === 0) throw new Error(t('shellAnalysis.needSupport'));
  if (session.supports.some(row => !row.fixed.some(Boolean))) throw new Error(t('shellAnalysis.needFixedDof'));
  const source = session.materialSource;
  if (source.kind === null || source.reference.trim() === '' || source.condition.trim() === '')
    throw new Error(t('shellAnalysis.needMaterialSource'));
  const value = (name: ShellField): number => evaluated(shellExpressionField(name, session.values[name], parameters).result);
  const load = (row: ShellEdgeLoadDraft, component: ShellLoadComponent): number =>
    evaluated(shellLoadExpressionField(row.key, component, row.values[component], parameters).result);
  const poisson = value('poisson');
  if (!(poisson > -1 && poisson < 0.5)) throw new Error(t('shellAnalysis.poissonRange'));
  try {
    return readShellCadAnalysisInput({ schema: SHELL_CAD_ANALYSIS_SCHEMA, id: 'shell-cad-analysis', source: { documentId },
      geometry: { schema: SHELL_CAD_SCHEMA, id: 'shell-cad', source: { documentId }, bodyFeatureId: session.bodyFeatureId,
        midsurfaceFaces: [...session.midsurfaceFaces], thicknessMm: value('thickness'), offsetMm: value('offset') },
      material: { id: session.kept.materialId, youngMPa: value('young'), poisson,
        source: { kind: source.kind, reference: source.reference.trim(), condition: source.condition.trim() } },
      supports: session.supports.map(row => ({ kind: row.kind, origin: structuredClone(row.origin), fixed: [...row.fixed] })),
      edgeLoads: session.edgeLoads.map(row => ({ origin: structuredClone(row.origin),
        forceNPerMm: [load(row, 'fx'), load(row, 'fy'), load(row, 'fz')],
        momentNmmPerMm: [load(row, 'mx'), load(row, 'my'), load(row, 'mz')] })),
      surface: { linearDeflection: value('linear'), angularDeflection: value('angular'),
        maximumNodes: session.kept.maximumNodes, maximumTriangles: session.kept.maximumTriangles,
        minimumTriangleAreaMm2: value('minimumArea'),
        minimumAngleDeg: value('minimumAngle'), maximumAspectRatio: value('maximumAspect') } });
  } catch (error) {
    throw new Error(`${t('shellAnalysis.invalidInput')} ${error instanceof Error ? error.message : ''}`.trim(), { cause: error });
  }
}

/** Japanese reason for the fem refusal codes (CadShellRefusalCode, surface refusals, client failures). */
const FAILURE_KEYS: Readonly<Record<string, MessageKey>> = {
  'midsurface-solid-face': 'shellAnalysis.failure.solidFace', 'midsurface-nonplanar': 'shellAnalysis.failure.nonplanar',
  'midsurface-unresolved': 'shellAnalysis.failure.unresolved', 'midsurface-incomplete': 'shellAnalysis.failure.incomplete',
  'midsurface-offset-fold': 'shellAnalysis.failure.offsetFold', 'support-unresolved': 'shellAnalysis.failure.supportUnresolved',
  'load-unresolved': 'shellAnalysis.failure.loadUnresolved', 'edge-load-fold': 'shellAnalysis.failure.edgeLoadFold',
  'edge-load-drilling': 'shellAnalysis.failure.drilling', 'invalid-settings': 'shellAnalysis.failure.invalidSettings',
  'result-binding': 'shellAnalysis.failure.resultBinding', stale: 'shellAnalysis.changed',
};
export function shellFailureMessage(code: string, message: string): string {
  const key = FAILURE_KEYS[code];
  return key === undefined ? `${t('shellAnalysis.failed')} (${code}) ${message}` : `${t(key)} (${code})`;
}

/** A finite number is shown as is; NaN, Infinity or a missing value is never shown as 0 or as safe. */
export function shellNumberText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : t('shellAnalysis.notFinite');
}

export interface ShellResultSummary {
  readonly nodes: number;
  readonly elements: number;
  readonly maximumDisplacementMm: number;
  readonly maximumRotationRad: number;
  readonly component: ShellStressComponent;
  readonly topMinimumMPa: number;
  readonly topMaximumMPa: number;
  readonly bottomMinimumMPa: number;
  readonly bottomMaximumMPa: number;
  readonly reactionForceN: readonly [number, number, number];
  readonly freeResidualRelative: number;
  readonly balanceRelative: number;
  /** False when any summarised number is NaN or infinite: the panel then shows the alert, never a value. */
  readonly finite: boolean;
}
const COMPONENT_INDEX: Readonly<Record<ShellStressComponent, number>> = { xx: 0, yy: 1, zz: 2, yz: 3, xz: 4, xy: 5 };
/** Pure summary of a bound result for the chosen display component. Changing the component changes nothing else. */
export function summarizeShellResult(result: CadShellAnalysisResult, component: ShellStressComponent): ShellResultSummary {
  const index = COMPONENT_INDEX[component];
  let maximumDisplacementMm = 0, maximumRotationRad = 0;
  let topMinimumMPa = Infinity, topMaximumMPa = -Infinity, bottomMinimumMPa = Infinity, bottomMaximumMPa = -Infinity;
  let finite = result.nodes.length > 0 && result.elements.length > 0;
  for (const node of result.nodes) {
    const [ux, uy, uz, rx, ry, rz] = node.displacement;
    maximumDisplacementMm = Math.max(maximumDisplacementMm, Math.hypot(ux, uy, uz));
    maximumRotationRad = Math.max(maximumRotationRad, Math.hypot(rx, ry, rz));
    if (![ux, uy, uz, rx, ry, rz].every(Number.isFinite)) finite = false;
  }
  for (const element of result.elements) for (const point of element.points) {
    const top = point.topMPa[index], bottom = point.bottomMPa[index];
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) finite = false;
    topMinimumMPa = Math.min(topMinimumMPa, top); topMaximumMPa = Math.max(topMaximumMPa, top);
    bottomMinimumMPa = Math.min(bottomMinimumMPa, bottom); bottomMaximumMPa = Math.max(bottomMaximumMPa, bottom);
  }
  const reaction: [number, number, number] = [0, 0, 0];
  for (const row of result.shell.reactions) for (let axis = 0; axis < 3; axis += 1) reaction[axis] += row[axis];
  const { freeResidualRelative, balanceRelative } = result.shell.checks;
  if (![...reaction, freeResidualRelative, balanceRelative, topMinimumMPa, topMaximumMPa, bottomMinimumMPa, bottomMaximumMPa]
    .every(Number.isFinite)) finite = false;
  return { nodes: result.nodes.length, elements: result.elements.length, maximumDisplacementMm, maximumRotationRad, component,
    topMinimumMPa, topMaximumMPa, bottomMinimumMPa, bottomMaximumMPa, reactionForceN: reaction, freeResidualRelative,
    balanceRelative, finite };
}
