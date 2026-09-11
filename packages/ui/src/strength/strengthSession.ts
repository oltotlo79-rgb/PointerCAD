import {
  calculateStrength, checkStrengthMaterialCondition, findMetricThread, findStrengthMaterial,
  readStrengthInputs, strengthMaterialSources, tensileStressArea,
  type LengthUnit, type Parameter, type StrengthCalculation, type StrengthCalculationOutcome,
  type StrengthCalculationValue, type StrengthFieldName, type TensileAreaMethod, type ThreadSeries,
} from '@pointercad/model';
import { t } from '../i18n/t.js';

export interface StrengthSnapshot {
  readonly value: StrengthCalculationValue;
  readonly materialId: string;
  readonly productThicknessSource: string;
  readonly lengthUnit: LengthUnit;
  readonly threadDesignation: string;
  readonly threadSeries: ThreadSeries;
  readonly areaMethod: TensileAreaMethod;
  readonly materialValuesEdited: boolean;
}
export interface StrengthSession {
  readonly calculation: StrengthCalculation;
  readonly sources: ReadonlyMap<StrengthFieldName, string>;
  readonly materialId: string;
  readonly productThicknessSource: string;
  /** Keep unqualified length expressions in the unit in which they were entered. */
  readonly lengthUnit: LengthUnit;
  readonly threadDesignation: string;
  readonly threadSeries: ThreadSeries;
  readonly areaMethod: TensileAreaMethod;
  readonly focusedField: string | null;
  readonly result: StrengthSnapshot | null;
  readonly edited: boolean;
}
export type StrengthEdit =
  | { readonly kind: 'source'; readonly field: StrengthFieldName; readonly source: string }
  | { readonly kind: 'calculation'; readonly calculation: StrengthCalculation }
  | { readonly kind: 'material'; readonly id: string }
  | { readonly kind: 'product-thickness'; readonly source: string }
  | { readonly kind: 'thread'; readonly designation: string }
  | { readonly kind: 'series'; readonly series: ThreadSeries }
  | { readonly kind: 'area-method'; readonly method: TensileAreaMethod }
  | { readonly kind: 'focus'; readonly field: string | null };

const materialFields: readonly StrengthFieldName[] = ['yieldStress', 'youngModulus', 'shearModulus'];
export function strengthUsesCustomValues(session: StrengthSession): boolean {
  const preset = findStrengthMaterial(session.materialId);
  if (preset === undefined) return true;
  const expected = strengthMaterialSources(preset);
  return materialFields.some(field => (session.sources.get(field) ?? '') !== (expected.get(field) ?? ''));
}
export function createStrengthSession(lengthUnit: LengthUnit): StrengthSession {
  const session: StrengthSession = {
    calculation: { kind: 'beam', section: 'rectangle', support: 'cantilever' },
    sources: new Map<StrengthFieldName, string>([
      ['width', '10mm'], ['height', '10mm'], ['diameter', '20mm'], ['thickness', '2mm'],
      ['length', '100mm'], ['force', '10N'], ['outerDiameter', '20mm'], ['innerDiameter', '0mm'],
      ['torque', '100N*m'], ['safetyFactor', '3'],
    ]),
    materialId: '', productThicknessSource: '10mm', lengthUnit,
    threadDesignation: 'M10', threadSeries: 'coarse', areaMethod: 'table',
    focusedField: 'width', result: null, edited: false,
  };
  return editStrengthSession(session, { kind: 'material', id: 'ss400-plate-0-16' });
}

/** Immutable UI state only. No document, history or kernel is reachable here. */
export function editStrengthSession(session: StrengthSession, edit: StrengthEdit): StrengthSession {
  if (edit.kind === 'focus') return { ...session, focusedField: edit.field };
  const updated = { ...session, edited: true };
  switch (edit.kind) {
    case 'source': return { ...updated, sources: new Map([...session.sources, [edit.field, edit.source]]) };
    case 'calculation': return { ...updated, calculation: edit.calculation, focusedField: null };
    case 'product-thickness': return { ...updated, productThicknessSource: edit.source };
    case 'thread': return { ...updated, threadDesignation: edit.designation };
    case 'series': return { ...updated, threadSeries: edit.series };
    case 'area-method': return { ...updated, areaMethod: edit.method };
    case 'material': {
      if (edit.id === '') return { ...updated, materialId: '' };
      const preset = findStrengthMaterial(edit.id);
      if (preset === undefined) return session;
      const material = strengthMaterialSources(preset);
      const sources = new Map(session.sources);
      // A missing elastic constant must never inherit the previous material's value.
      for (const field of materialFields) sources.set(field, material.get(field) ?? '');
      return { ...updated, materialId: preset.id, sources };
    }
  }
}

export function strengthSessionArea(session: Pick<StrengthSession, 'threadDesignation' | 'threadSeries' | 'areaMethod'>) {
  const thread = findMetricThread(session.threadDesignation);
  return tensileStressArea(thread?.diameter ?? Number.NaN,
    thread === undefined ? Number.NaN : session.threadSeries === 'coarse' ? thread.coarsePitch : thread.finePitch,
    session.areaMethod);
}

export function evaluateStrengthSession(session: StrengthSession, parameters: readonly Parameter[]): StrengthCalculationOutcome {
  const preset = findStrengthMaterial(session.materialId);
  if (preset !== undefined && preset.thicknessMm !== null) {
    const thickness = readStrengthInputs([{ name: 'productThickness', source: session.productThicknessSource, quantity: 'length' }], parameters, session.lengthUnit);
    if (!thickness.ok) return thickness;
    const checked = checkStrengthMaterialCondition(preset, thickness.values.get('productThickness')?.canonical.value ?? null);
    if (!checked.ok) return { ok: false, field: 'productThickness', message: t('strength.error.thickness') };
  }
  const sources = new Map(session.sources);
  if (session.calculation.kind === 'bolt') {
    const area = strengthSessionArea(session);
    if (!area.ok) return { ok: false, field: 'tensileArea', message: t('strength.error.area') };
    sources.set('tensileArea', area.area.exact);
  }
  return calculateStrength({ calculation: session.calculation, sources, parameters, lengthUnit: session.lengthUnit });
}

export function calculateStrengthSession(session: StrengthSession, parameters: readonly Parameter[]): StrengthSession {
  const calculated = evaluateStrengthSession(session, parameters);
  if (!calculated.ok) return { ...session, focusedField: calculated.field };
  return { ...session, edited: false, focusedField: null, result: {
    value: calculated.value, materialId: session.materialId, productThicknessSource: session.productThicknessSource,
    lengthUnit: session.lengthUnit, threadDesignation: session.threadDesignation, threadSeries: session.threadSeries, areaMethod: session.areaMethod,
    materialValuesEdited: strengthUsesCustomValues(session),
  } };
}
