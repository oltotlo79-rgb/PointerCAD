import { evaluateExpression, type ExpressionError, type ExpressionValue } from '@pointercad/expression';
import {
  assemblyVariables,
  findComponent,
  resolveMateTarget,
  selectMateTargetGeometry,
  nextMateId,
  type AssemblyDocument,
  type Mate,
  type MateKind,
  type MateTarget,
  type MateTargetKind,
} from '@pointercad/model';
import { t } from '../i18n/t.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { parseSubShapeId, subShapeElementId } from '../solid/subShapeSelection.js';

export interface AssemblyMateDraft {
  readonly documentId: string;
  readonly kind: MateKind;
  readonly targets: readonly MateTarget[];
  readonly targetKinds: readonly MateTargetKind[];
  readonly source: string;
  readonly flipped: boolean;
  readonly editingMateId: string | null;
  readonly mode?: 'selection' | 'command';
  readonly alignmentChosen?: boolean;
  readonly issue?: string | null;
}

export interface MateFacePick {
  readonly componentId: string;
  readonly partKey: string;
  readonly bodyFeatureId: string;
  readonly faceIndex: number;
}

export type MateCommandOutcome =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly mate: Mate }
  | { readonly ok: false; readonly reason: 'targets' | 'sameComponent' | 'kind' | 'value' | 'stale'; readonly error?: ExpressionError; readonly message?: string };

export function createMateDraft(documentId: string, kind: MateKind): AssemblyMateDraft {
  return { documentId, kind, targets: [], targetKinds: [], source: defaultMateSource(kind), flipped: false, editingMateId: null, mode: 'command' };
}

export function editMateDraft(documentId: string, mate: Mate): AssemblyMateDraft {
  return {
    documentId,
    kind: mate.kind,
    targets: [mate.a, mate.b],
    targetKinds: [],
    source: mate.value?.source ?? '',
    flipped: mate.flipped,
    editingMateId: mate.id,
    mode: 'command',
    alignmentChosen: true,
  };
}

export function appendMateTarget(
  draft: AssemblyMateDraft,
  target: MateTarget,
  targetKind: MateTargetKind,
): AssemblyMateDraft | null {
  if ((draft.mode !== 'selection' && draft.targets.length >= 2) || draft.targets.some((item) => item.componentId === target.componentId)) return null;
  return { ...draft, targets: [...draft.targets, target], targetKinds: [...draft.targetKinds, targetKind] };
}

export function availableMateKinds(a: MateTargetKind, b: MateTargetKind): readonly MateKind[] {
  if (a === 'point' && b === 'point') return ['coincident', 'distance'];
  if ((a === 'point' && b === 'plane') || (a === 'plane' && b === 'point')) return ['coincident', 'distance'];
  if (a === 'plane' && b === 'plane') return ['coincident', 'parallel', 'distance', 'angle'];
  if ((a === 'cylinder' && b === 'plane') || (a === 'plane' && b === 'cylinder')) return ['tangent'];
  if ((a === 'axis' || a === 'cylinder') && (b === 'axis' || b === 'cylinder')) return ['concentric', 'parallel', 'angle'];
  if ((a === 'axis' && b === 'plane') || (a === 'plane' && b === 'axis')) return ['parallel', 'angle'];
  return [];
}

export function mateKindNeedsValue(kind: MateKind, kinds: readonly MateTargetKind[] = []): boolean {
  return kind === 'distance' || kind === 'angle' || (kind === 'coincident' && kinds.length === 2 && kinds.every((value) => value === 'plane'));
}

export function defaultMateSource(kind: MateKind): string { return kind === 'angle' ? '90' : '0'; }

/** 部品内IDをcomponentと組にする。保存指紋の座標は変換しない。 */
export function assemblyTargetId(target: MateTarget): string {
  const element = target.kind === 'origin' ? `@${target.element}`
    : subShapeElementId(target.ref.bodyFeatureId, target.ref.fingerprint.kind, target.ref.index);
  return `assembly-target:${encodeURIComponent(target.componentId)}/${encodeURIComponent(element)}`;
}

export function parseAssemblyTargetId(id: string): { readonly componentId: string; readonly elementId: string } | null {
  if (!id.startsWith('assembly-target:')) return null;
  const parts = id.slice('assembly-target:'.length).split('/');
  if (parts.length !== 2) return null;
  try {
    const componentId = decodeURIComponent(parts[0]);
    const elementId = decodeURIComponent(parts[1]);
    return componentId !== '' && (parseSubShapeId(elementId) !== null || /^@(origin|x|y|z|xy|xz|yz)$/u.test(elementId))
      ? { componentId, elementId } : null;
  } catch { return null; }
}

export function resolveCurrentMateTarget(document: AssemblyDocument, view: AssemblyView, target: MateTarget): ReturnType<typeof resolveMateTarget> {
  const component = findComponent(document, target.componentId);
  if (component === undefined || component.suppressed) return { ok: false, code: 'missingComponent', message: t('assembly.mate.targetMissing') };
  return resolveMateTarget(target, view.resolved, { subShape: (partKey, reference) => {
    const body = view.bodies.get(partKey)?.find((item) => item.featureId === reference.bodyFeatureId);
    return body === undefined ? null : selectMateTargetGeometry(body, reference);
  } });
}

/** 現在の法線を使い、coincidentの既定を向かい合わせへ揃える。 */
export function refreshMateDraft(document: AssemblyDocument, view: AssemblyView, draft: AssemblyMateDraft): AssemblyMateDraft {
  const resolved = draft.targets.map((target) => resolveCurrentMateTarget(document, view, target));
  const targetKinds = resolved.flatMap((result) => result.ok ? [result.target.kind] : []);
  const a = resolved[0];
  const b = resolved[1];
  const kind = draft.mode === 'selection' && targetKinds.length === 2
    ? availableMateKinds(targetKinds[0], targetKinds[1])[0] ?? draft.kind : draft.kind;
  const normals = a?.ok === true && b?.ok === true && a.target.kind === 'plane' && b.target.kind === 'plane'
    ? [a.target.direction, b.target.direction] : [];
  const [na, nb] = normals;
  const flipped = kind === 'coincident' && !draft.alignmentChosen && na != null && nb != null
    ? na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] >= 0 : draft.flipped;
  return { ...draft, kind, targetKinds, flipped, source: kind === draft.kind ? draft.source : defaultMateSource(kind) };
}

function valueFromSource(
  document: AssemblyDocument,
  kind: MateKind,
  source: string,
  kinds: readonly MateTargetKind[],
): { readonly ok: true; readonly value: ExpressionValue | undefined } | { readonly ok: false; readonly error: ExpressionError } {
  if (!mateKindNeedsValue(kind, kinds)) return { ok: true, value: undefined };
  const entered = source.trim() === '' ? '0' : source;
  const result = evaluateExpression(entered, { variables: assemblyVariables(document) });
  if (!result.ok) return result;
  if (kind === 'distance' && result.value.value < 0) {
    return { ok: false, error: { code: 'outOfRange', message: t('assembly.mate.negativeDistance'), position: -1 } };
  }
  if (kind === 'angle' && (result.value.value <= 1 || result.value.value >= 179)) {
    return { ok: false, error: { code: 'outOfRange', message: t('assembly.mate.angleRange'), position: -1 } };
  }
  return { ok: true, value: result.value };
}

export function commitMate(document: AssemblyDocument, draft: AssemblyMateDraft): MateCommandOutcome {
  const [a, b] = draft.targets;
  const [ka, kb] = draft.targetKinds;
  if (draft.targets.length !== 2 || a === undefined || b === undefined) return { ok: false, reason: 'targets' };
  if (a.componentId === b.componentId) return { ok: false, reason: 'sameComponent' };
  if ([a, b].some((target) => { const component = findComponent(document, target.componentId); return component === undefined || component.suppressed; })) return { ok: false, reason: 'stale' };
  if (ka === undefined || kb === undefined || !availableMateKinds(ka, kb).includes(draft.kind)) {
    return { ok: false, reason: 'kind' };
  }
  const evaluated = valueFromSource(document, draft.kind, draft.source, draft.targetKinds);
  if (!evaluated.ok) return { ok: false, reason: 'value', error: evaluated.error };
  const previous = draft.editingMateId === null ? undefined : document.mates.find((mate) => mate.id === draft.editingMateId);
  if (draft.editingMateId !== null && previous === undefined) return { ok: false, reason: 'stale' };
  const mate: Mate = {
    id: previous?.id ?? nextMateId(document),
    name: previous?.name ?? t('assembly.mate.defaultName').replace('{count}', String(document.mates.length + 1)),
    kind: draft.kind,
    a,
    b,
    ...(evaluated.value === undefined ? {} : { value: evaluated.value }),
    flipped: draft.flipped,
    suppressed: previous?.suppressed ?? false,
  };
  const mates = previous === undefined
    ? [...document.mates, mate]
    : document.mates.map((item) => item.id === previous.id ? mate : item);
  return { ok: true, document: { ...document, mates }, mate };
}

export function removeMate(document: AssemblyDocument, mateId: string): AssemblyDocument {
  const mates = document.mates.filter((mate) => mate.id !== mateId);
  return mates.length === document.mates.length ? document : { ...document, mates };
}

export function toggleMateFlipped(document: AssemblyDocument, mateId: string): AssemblyDocument {
  const mate = document.mates.find((item) => item.id === mateId);
  return mate === undefined ? document : {
    ...document,
    mates: document.mates.map((item) => item.id === mateId ? { ...item, flipped: !item.flipped } : item),
  };
}
