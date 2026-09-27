/** GR-19a: pure display/readiness data for GR-19b. No document edits or stored derived values. */
import { checkVariableName, expressionValueFromNumber } from '@pointercad/expression';
import {
  analyzeMathGeometryDependencies,
  EMPTY_MATH_GEOMETRY_USAGE,
  featureIdOfPointKey,
  formatDisplayLength,
  mathGeometryAngleUnitOf,
  mathGeometryTargetsOf,
  mathGeometryUsage,
  type LengthUnit,
  type MathGeometryDefinition,
  type MathGeometryOutcome,
  type MathGeometryQuantity,
  type MathGeometryTarget,
  type PartDocument,
} from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { formatMeasureValue } from '../solid/measureCommands.js';
import { AREA_UNIT_KEYS, formatArea, formatVolume, VOLUME_UNIT_KEYS } from '../solid/measureFormatting.js';
import type { AppState } from '../store/appState.js';
import { activePartDocument } from '../store/documentKind.js';
import { currentMathGeometry, type CurrentMathGeometry, type MathGeometryUnresolvedReason } from './mathGeometryResults.js';
import { mathGeometrySelection } from './mathGeometrySelection.js';
import { mathGeometryToleranceText } from './mathGeometryTolerance.js';
import { mathGeometryToolGuide, mathGeometryToolGuideText, type MathGeometryToolGuideState } from './mathGeometryToolGuide.js';

export const MATH_GEOMETRY_REASON_KEYS = {
  'missing-reference': 'mathGeometry.reason.missing-reference',
  'failed-geometry': 'mathGeometry.reason.failed-geometry',
  unsupported: 'mathGeometry.reason.unsupported',
  'invalid-request': 'mathGeometry.reason.invalid-request',
  'ambiguous-reference': 'mathGeometry.reason.ambiguous-reference',
} as const satisfies Record<MathGeometryUnresolvedReason, MessageKey>;

const KIND_KEYS = {
  'point-distance': 'mathGeometry.kind.point-distance',
  'shape-distance': 'mathGeometry.kind.shape-distance',
  length: 'mathGeometry.kind.length',
  area: 'mathGeometry.kind.area',
  volume: 'mathGeometry.kind.volume',
  angle: 'mathGeometry.kind.angle',
  parallel: 'mathGeometry.kind.parallel',
  perpendicular: 'mathGeometry.kind.perpendicular',
  'plane-angle': 'mathGeometry.kind.plane-angle',
  'line-plane-angle': 'mathGeometry.kind.line-plane-angle',
  'point-angle': 'mathGeometry.kind.point-angle',
  radius: 'mathGeometry.kind.radius',
  'central-angle': 'mathGeometry.kind.central-angle',
  'contour-length': 'mathGeometry.kind.contour-length',
  // GR-22: G1 comparisons (packages/model/src/measure/mathGeometryCongruence.ts).
  congruent: 'mathGeometry.kind.congruent',
  similar: 'mathGeometry.kind.similar',
} as const satisfies Record<Exclude<MathGeometryQuantity['kind'], 'coordinate'>, MessageKey>;

const STATUS_KEYS = {
  notPart: 'mathGeometry.disabled.notPart',
  computing: 'mathGeometry.status.computing',
  cancelled: 'mathGeometry.status.cancelled',
  timeline: 'mathGeometry.status.timeline',
  notEvaluated: 'mathGeometry.status.notEvaluated',
} as const satisfies Record<Exclude<CurrentMathGeometry['status'], 'current'>, MessageKey>;

export type MathGeometryRowsState = MathGeometryToolGuideState & {
  readonly displaySettings: Pick<AppState['displaySettings'], 'lengthUnit'>;
};

export interface MathGeometryReadiness {
  readonly ready: boolean;
  readonly reasonKey: MessageKey | null;
  readonly reasonText: string | null;
}

export interface MathGeometryCandidateRow {
  readonly quantity: MathGeometryQuantity;
  readonly kindKey: MessageKey;
  readonly kindLabel: string;
  readonly targetsSummary: string;
}

export interface MathGeometryRow extends MathGeometryCandidateRow {
  readonly id: string;
  readonly name: string;
  readonly valueText: string | null;
  readonly statusKey: MessageKey | null;
  readonly statusText: string | null;
  readonly toleranceText: string;
  readonly toleranceNote: string;
  readonly usageCount: number;
  readonly usageNames: readonly string[];
  readonly usageText: string;
  readonly circular: boolean;
  readonly cycleText: string | null;
  readonly cycleMessage: string | null;
  /** Non-null for every angular quantity, via the model's public helper. */
  readonly angleUnit: 'degree' | 'radian' | null;
  readonly reselect: MathGeometryReadiness & { readonly quantity: MathGeometryQuantity | null };
  readonly remove: MathGeometryReadiness;
  readonly createParameter: MathGeometryReadiness;
}

const READY: MathGeometryReadiness = Object.freeze({ ready: true, reasonKey: null, reasonText: null });

function disabled(reasonKey: MessageKey, reasonText: string = t(reasonKey)): MathGeometryReadiness {
  return { ready: false, reasonKey, reasonText };
}

export function mathGeometryKindKey(quantity: MathGeometryQuantity): MessageKey {
  return quantity.kind === 'coordinate'
    ? `mathGeometry.kind.coordinate.${quantity.component}` : KIND_KEYS[quantity.kind];
}

/** Read the current document's names on every call, including after rename/Undo. Missing IDs stay visible. */
function targetText(document: PartDocument, target: MathGeometryTarget): string {
  switch (target.kind) {
    case 'sketch-point': case 'sketch-curve': {
      const sketch = document.sketches.find(item => item.id === target.sketchId);
      const id = target.kind === 'sketch-point' ? target.reference.pointId : target.featureId;
      const featureId = target.kind === 'sketch-point' ? featureIdOfPointKey(id) : id;
      const name = sketch?.features.find(item => item.id === featureId)?.name ?? id;
      const label = t(target.kind === 'sketch-point' ? 'propertyPanel.base.point' : 'selection.kind.edge');
      return `${sketch?.name ?? target.sketchId} / ${name} (${label}: ${id})`;
    }
    case 'body': {
      const name = document.solids.find(item => item.id === target.featureId)?.name ?? target.featureId;
      return `${name} (${t('selection.kind.body')})`;
    }
    case 'reference': {
      const name = document.references.find(item => item.id === target.featureId)?.name ?? target.featureId;
      return `${name} (${t('toolbar.reference.coordinateSystem')})`;
    }
    case 'vertex': case 'edge': case 'face': {
      const reference = target.reference;
      const name = document.solids.find(item => item.id === reference.bodyFeatureId)?.name ?? reference.bodyFeatureId;
      return `${name} (${t(`selection.kind.${target.kind}`)} ${String(reference.index + 1)})`;
    }
  }
}

export function mathGeometryTargetsSummary(document: PartDocument, quantity: MathGeometryQuantity): string {
  return mathGeometryTargetsOf(quantity).map(target => targetText(document, target)).join(' / ');
}

/** Includes units; the value itself remains in the model's internal units. */
export function mathGeometryValueText(outcome: Extract<MathGeometryOutcome, { readonly status: 'value' }>,
  lengthUnit: LengthUnit): string | null {
  if (outcome.kind === 'boolean') return t(outcome.value ? 'mathGeometry.boolean.true' : 'mathGeometry.boolean.false');
  if (!Number.isFinite(outcome.value)) return null;
  switch (outcome.unit) {
    case 'mm': return formatDisplayLength(outcome.value, lengthUnit);
    case 'mm2': return `${formatArea(outcome.value, lengthUnit)} ${t(AREA_UNIT_KEYS[lengthUnit])}`;
    case 'mm3': return `${formatVolume(outcome.value, lengthUnit)} ${t(VOLUME_UNIT_KEYS[lengthUnit])}`;
    case 'degree': return formatMeasureValue({ kind: 'faceAngle', value: outcome.value, unit: 'degree', segment: null });
    case 'radian': return `${expressionValueFromNumber(outcome.value).display} ${t('mathGeometry.unit.radian')}`;
  }
}

export function mathGeometryPanelVisible(state: Pick<AppState, 'document' | 'assembly' | 'drawing' | 'activeTool'>): boolean {
  return state.activeTool === 'mathGeometry' && activePartDocument(state) !== null;
}

/** Safe as a React store selector: return the guide's string, never its freshly allocated object. */
export function mathGeometryPanelGuideText(state: MathGeometryToolGuideState): string | null {
  const guide = mathGeometryToolGuide(state);
  return guide === null ? null : mathGeometryToolGuideText(guide);
}

/**
 * GR-22: also passes the document's reference geometry, so a selection pairing a point with a
 * reference coordinate system offers `coordinate` in that frame. GR-22b brought
 * `mathGeometryToolGuide.ts`'s own call to `mathGeometrySelection` up to the same 5 arguments (it
 * passes `activePartDocument(state)?.references ?? []` the same way), so the status-bar guide's stage
 * and count agree with this candidate list — neither call relies any longer on the 5th argument's `[]`
 * default to keep compiling.
 */
function selectionOf(state: MathGeometryToolGuideState) {
  const references = activePartDocument(state)?.references ?? [];
  return mathGeometrySelection(state.selection, state.sketch.id, state.resolvedSketch, state.bodies, references);
}

function candidateRow(document: PartDocument, quantity: MathGeometryQuantity): MathGeometryCandidateRow {
  const kindKey = mathGeometryKindKey(quantity);
  return { quantity, kindKey, kindLabel: t(kindKey), targetsSummary: mathGeometryTargetsSummary(document, quantity) };
}

export function mathGeometryCandidateRows(state: MathGeometryToolGuideState): readonly MathGeometryCandidateRow[] {
  const document = activePartDocument(state);
  if (document === null || currentMathGeometry(state).status === 'computing') return [];
  return selectionOf(state).candidates.map(quantity => candidateRow(document, quantity));
}

export function mathGeometryAddReadiness(state: MathGeometryToolGuideState): MathGeometryReadiness {
  if (activePartDocument(state) === null) return disabled('mathGeometry.disabled.notPart');
  const selection = selectionOf(state);
  if (selection.reason === 'nothingSelected' || selection.reason === 'tooMany') {
    return disabled(`mathGeometry.disabled.${selection.reason}`);
  }
  if (currentMathGeometry(state).status === 'computing') return disabled('mathGeometry.disabled.computing');
  return selection.reason === null ? READY : disabled(`mathGeometry.disabled.${selection.reason}`);
}

/** No implicit unit change during reselection. Coordinates also preserve their component. */
export function mathGeometryReselectCandidate(quantity: MathGeometryQuantity,
  candidates: readonly MathGeometryQuantity[]): MathGeometryQuantity | null {
  return candidates.find(candidate => candidate.kind === quantity.kind
    && mathGeometryAngleUnitOf(candidate) === mathGeometryAngleUnitOf(quantity)
    && (quantity.kind !== 'coordinate' || (candidate.kind === 'coordinate' && candidate.component === quantity.component))) ?? null;
}

interface RowValue {
  readonly valueText: string | null;
  readonly statusKey: MessageKey | null;
  readonly statusText: string | null;
  readonly real: boolean;
}

function unavailable(key: MessageKey, detail?: string | null): RowValue {
  return { valueText: null, statusKey: key, statusText: detail ? `${t(key)} ${detail}` : t(key), real: false };
}

function rowValue(document: PartDocument, definition: MathGeometryDefinition,
  current: CurrentMathGeometry, lengthUnit: LengthUnit): RowValue {
  if (current.status !== 'current') {
    return unavailable(STATUS_KEYS[current.status], current.status === 'notEvaluated' ? current.message : null);
  }
  const outcome = current.outcomes.get(definition.id);
  if (outcome === undefined || outcome.id !== definition.id || outcome.documentId !== document.id
    || outcome.generation !== current.generation) return unavailable('mathGeometry.status.pending');
  if (outcome.status === 'unresolved') return unavailable(MATH_GEOMETRY_REASON_KEYS[outcome.reason], outcome.message);
  const valueText = mathGeometryValueText(outcome, lengthUnit);
  if (valueText === null) return unavailable(MATH_GEOMETRY_REASON_KEYS['failed-geometry']);
  return { valueText, statusKey: null, statusText: null, real: outcome.kind === 'real' };
}

function createParameterReadiness(document: PartDocument, definition: MathGeometryDefinition, real: boolean): MathGeometryReadiness {
  if (!real) return disabled('mathGeometry.createParameter.disabled.noValue');
  const name = `${definition.name}${t('mathGeometry.createParameter.nameSuffix')}`;
  // This is a parameter name (GR-31/commitAddParameter), not a new geometry definition name.
  if (checkVariableName(name) !== null) return disabled('mathGeometry.createParameter.disabled.invalidName');
  const duplicate = document.parameters.some(item => item.name === name)
    || document.mathGeometry?.some(item => item.name === name) === true;
  return duplicate ? disabled('mathGeometry.createParameter.disabled.duplicateName') : READY;
}

/** Call from a render/useMemo with selected state fields, not as a bare Zustand selector (returns an array). */
export function mathGeometryRows(state: MathGeometryRowsState): readonly MathGeometryRow[] {
  const document = activePartDocument(state);
  if (document === null) return [];
  const current = currentMathGeometry(state);
  const candidates = current.status === 'computing' ? [] : selectionOf(state).candidates;
  const usages = mathGeometryUsage(document);
  const cycles = analyzeMathGeometryDependencies(document).cycles;
  return (document.mathGeometry ?? []).map(definition => {
    const value = rowValue(document, definition, current, state.displaySettings.lengthUnit);
    const usage = usages.get(definition.id) ?? EMPTY_MATH_GEOMETRY_USAGE;
    const usageNames = [...usage.parameterNames, ...usage.configurationNames, ...usage.unresolvedProblemNames];
    const cycle = cycles.find(item => item.definitionIds.includes(definition.id));
    const quantity = mathGeometryReselectCandidate(definition.quantity, candidates);
    const reselect = current.status === 'computing' ? disabled('mathGeometry.disabled.computing')
      : quantity === null ? disabled('mathGeometry.disabled.reselectKind') : READY;
    return {
      ...candidateRow(document, definition.quantity),
      id: definition.id, name: definition.name,
      valueText: value.valueText, statusKey: value.statusKey, statusText: value.statusText,
      toleranceText: mathGeometryToleranceText(definition.tolerance), toleranceNote: t('mathGeometry.toleranceNote'),
      usageCount: usageNames.length, usageNames,
      usageText: usageNames.length === 0 ? t('mathGeometry.unused') : `${String(usageNames.length)}${t('mathGeometry.usageSuffix')}`,
      circular: cycle !== undefined, cycleText: cycle === undefined ? null : t('mathGeometry.circular'),
      cycleMessage: cycle?.message ?? null,
      angleUnit: mathGeometryAngleUnitOf(definition.quantity),
      reselect: { ...reselect, quantity },
      remove: usageNames.length === 0 ? READY : disabled('mathGeometry.error.referencedBy',
        t('mathGeometry.error.referencedBy').replace('{names}', usageNames.join(' / '))),
      createParameter: createParameterReadiness(document, definition, value.real),
    };
  });
}
