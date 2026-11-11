import type { Parameter } from '@pointercad/model';
import type { SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { beamExpressionField, plasticBarExpressionField } from '../beam/beamFields.js';
import { t } from '../i18n/t.js';

export const SOLID_BOUNDARY_AXES = ['x', 'y', 'z'] as const;
export type SolidBoundaryAxis = typeof SOLID_BOUNDARY_AXES[number];
export type SolidGravityField = SolidBoundaryAxis | 'density';
export const SOLID_BOUNDARY_INDEX: Readonly<Record<SolidBoundaryAxis, 0 | 1 | 2>> = { x: 0, y: 1, z: 2 };
 interface SolidSupportDraft {
  readonly face: string;
  readonly fixed: readonly [boolean, boolean, boolean];
  readonly displacement: readonly [string, string, string];
  /** Preserve the distinction between omitted zero values and explicitly authored displacements. */
  readonly prescribed: boolean;
}
 interface SolidGravityDraft {
  readonly enabled: boolean;
  readonly acceleration: readonly [string, string, string];
  readonly density: string;
}
export interface SolidBoundaryDraft {
  readonly supports?: readonly SolidSupportDraft[];
  readonly gravity?: SolidGravityDraft;
  readonly boundaryFocused?: string | null;
}
export function createSolidSupport(face: string): SolidSupportDraft {
  return { face, fixed: [true, true, true], displacement: ['0', '0', '0'], prescribed: false };
}
export function createSolidBoundaryDraft(saved?: SolidCadSavedInput): Required<Pick<SolidBoundaryDraft, 'supports' | 'gravity'>> {
  return { supports: saved?.supports?.map(row => ({ face: row.face, fixed: [row.fixed[0], row.fixed[1], row.fixed[2]] as const,
    displacement: [String(row.prescribedMm?.[0] ?? 0), String(row.prescribedMm?.[1] ?? 0), String(row.prescribedMm?.[2] ?? 0)] as const,
    prescribed: row.prescribedMm !== undefined })) ?? [],
  gravity: saved?.gravity === undefined ? { enabled: false, acceleration: ['0', '0', '-9.81'], density: '' }
    : { enabled: true, acceleration: [String(saved.gravity.accelerationMps2[0]), String(saved.gravity.accelerationMps2[1]),
      String(saved.gravity.accelerationMps2[2])], density: String(saved.gravity.densityKgM3) } };
}
const DISPLACEMENT_LABELS = { x: 'solidAnalysis.supportDx', y: 'solidAnalysis.supportDy', z: 'solidAnalysis.supportDz' } as const;
const GRAVITY_LABELS = { x: 'solidAnalysis.gravityX', y: 'solidAnalysis.gravityY', z: 'solidAnalysis.gravityZ',
  density: 'solidAnalysis.gravityDensity' } as const;
export function solidSupportExpressionField(axis: SolidBoundaryAxis, key: string, source: string, parameters: readonly Parameter[]) {
  const field = beamExpressionField('cx', source, parameters);
  return { ...field, field: { ...field.field, key, labelKey: DISPLACEMENT_LABELS[axis], tooltipKey: 'solidAnalysis.supportDisplacementHelp' as const },
    result: { ...field.result, key } };
}
function accelerationExpression(source: string): string {
  const trimmed = source.trim();
  for (const suffix of ['m/s²', 'm/s2', 'm/s^2']) {
    if (!trimmed.endsWith(suffix)) continue;
    const prefix = trimmed.slice(0, -suffix.length);
    // A preceding unit letter (e.g. cm/s²) must not be interpreted as metres.
    if (/[0-9.)\s]$/u.test(prefix)) return prefix.trim();
  }
  return source;
}
export function solidGravityExpressionField(name: SolidGravityField, source: string, parameters: readonly Parameter[]) {
  const key = `solid-gravity-${name}`;
  const field = name === 'density' ? beamExpressionField('density', source, parameters)
    : plasticBarExpressionField('poisson', key, accelerationExpression(source), parameters);
  return { ...field, field: { ...field.field, key, source, labelKey: GRAVITY_LABELS[name], tooltipKey: 'solidAnalysis.gravityInputHelp' as const },
    result: { ...field.result, key }, unitLabel: name === 'density' ? 'kg/m³' : 'm/s²' };
}
function evaluated(field: Pick<ReturnType<typeof beamExpressionField>, 'result'>): number {
  if (field.result.value === null) throw new Error(field.result.error?.message ?? t('solidAnalysis.failed'));
  return field.result.value.value;
}
export function solidBoundarySaved(draft: SolidBoundaryDraft, parameters: readonly Parameter[]): Pick<SolidCadSavedInput, 'supports' | 'gravity'> {
  const rows = draft.supports ?? [];
  const supports = rows.map((row, index) => {
    if (!row.fixed.some(Boolean)) throw new Error(t('solidAnalysis.supportAllFree'));
    const displacement = SOLID_BOUNDARY_AXES.map(axis => evaluated(solidSupportExpressionField(axis,
      `solid-support-${index}-${axis}`, row.displacement[SOLID_BOUNDARY_INDEX[axis]], parameters)));
    if (displacement.some((value, axis) => !row.fixed[axis] && value !== 0)) throw new Error(t('solidAnalysis.supportFreeDisplacement'));
    const prescribedMm = [displacement[0], displacement[1], displacement[2]] as const;
    return { face: row.face, fixed: row.fixed,
      ...(row.prescribed || displacement.some(value => value !== 0) ? { prescribedMm } : {}) };
  });
  const gravity = draft.gravity;
  return { ...(supports.length === 0 ? {} : { supports }), ...(gravity?.enabled === true ? { gravity: {
    accelerationMps2: [evaluated(solidGravityExpressionField('x', gravity.acceleration[0], parameters)),
      evaluated(solidGravityExpressionField('y', gravity.acceleration[1], parameters)),
      evaluated(solidGravityExpressionField('z', gravity.acceleration[2], parameters))] as const,
    densityKgM3: evaluated(solidGravityExpressionField('density', gravity.density, parameters)),
  } } : {}) };
}
export function solidBoundaryFailure(message: string): string {
  if (message.includes('Conflicting prescribed displacement')) return t('solidAnalysis.supportConflict');
  if (message.includes('unrestrained component rigid-body motion')) return t('solidAnalysis.supportRigid');
  if (message.includes('Invalid translation restraints')) return t('solidAnalysis.supportAllFree');
  return message;
}
