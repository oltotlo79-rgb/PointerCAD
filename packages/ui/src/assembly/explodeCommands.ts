/** P7 タスク35。分解ステップを作るまでの判断を DOM とストアから分離した純関数。 */
import { evaluateExpression } from '@pointercad/expression';
import {
  addExplodeStep, assemblyExpressionContext,
  type AssemblyDocument, type AxisSpec, type MateTarget,
} from '@pointercad/model';

export interface AssemblyExplodeDraft {
  readonly sourceDocument: AssemblyDocument;
  readonly componentIds: readonly string[];
  readonly direction: AxisSpec;
}

export type ExplodeDraftResult =
  | { readonly ok: true; readonly draft: AssemblyExplodeDraft }
  | { readonly ok: false; readonly reason: 'noSelection' };

export type ExplodeCommitResult =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly stepId: string }
  | { readonly ok: false; readonly reason: 'staleDocument' | 'invalidExpression' | 'invalidStep' };

/** 選択順ではなく文書順へ揃え、部分形状や重複した id を分解対象へ混ぜない。 */
export function explodeSelection(
  document: AssemblyDocument,
  selection: readonly string[],
): readonly string[] {
  const selected = new Set(selection);
  return document.components
    .filter((component) => selected.has(component.id) && !component.suppressed)
    .map((component) => component.id);
}

function targetAxis(target: MateTarget): AxisSpec | null {
  if (target.kind === 'origin') {
    return target.element === 'x' || target.element === 'y' || target.element === 'z'
      ? { kind: 'world', axis: target.element }
      : null;
  }
  const axis = target.ref.fingerprint.kind === 'vertex' ? null : target.ref.fingerprint.axis;
  if (axis === null || axis.some((value) => !Number.isFinite(value)) || Math.hypot(...axis) <= 1e-12) {
    return null;
  }
  const magnitudes = axis.map(Math.abs);
  const index = magnitudes[1] > magnitudes[0]
    ? (magnitudes[2] > magnitudes[1] ? 2 : 1)
    : (magnitudes[2] > magnitudes[0] ? 2 : 0);
  return { kind: 'world', axis: (['x', 'y', 'z'] as const)[index] };
}

/** 最初の有効な同心合致の選択側軸を使い、見つからなければ世界 Z 軸にする。 */
export function inferExplodeDirection(
  document: AssemblyDocument,
  componentIds: readonly string[],
): AxisSpec {
  const selected = new Set(componentIds);
  for (const mate of document.mates) {
    if (mate.suppressed || mate.kind !== 'concentric') continue;
    const target = selected.has(mate.a.componentId) ? mate.a
      : selected.has(mate.b.componentId) ? mate.b : null;
    if (target === null) continue;
    const axis = targetAxis(target);
    if (axis !== null) return axis;
  }
  return { kind: 'world', axis: 'z' };
}

export function createExplodeDraft(
  document: AssemblyDocument,
  selection: readonly string[],
): ExplodeDraftResult {
  const componentIds = explodeSelection(document, selection);
  return componentIds.length === 0
    ? { ok: false, reason: 'noSelection' }
    : { ok: true, draft: { sourceDocument: document, componentIds,
      direction: inferExplodeDirection(document, componentIds) } };
}

/** 距離の入力式をそのまま保存し、複数部品でも履歴へ積む文書は 1 つだけ返す。 */
export function commitExplodeDraft(
  document: AssemblyDocument,
  draft: AssemblyExplodeDraft,
  distanceSource: string,
  name: string,
  interval: { readonly start: number; readonly end: number } = { start: 0, end: 1 },
): ExplodeCommitResult {
  if (document !== draft.sourceDocument) return { ok: false, reason: 'staleDocument' };
  const distance = evaluateExpression(distanceSource, assemblyExpressionContext(document));
  if (!distance.ok) return { ok: false, reason: 'invalidExpression' };
  const added = addExplodeStep(document, {
    name,
    start: interval.start,
    end: interval.end,
    body: { kind: 'explode', componentIds: draft.componentIds,
      direction: draft.direction, distance: distance.value },
  });
  return added.ok
    ? { ok: true, document: added.value, stepId: added.value.presentation.at(-1)?.id ?? '' }
    : { ok: false, reason: added.reason === 'invalidExpression' ? 'invalidExpression' : 'invalidStep' };
}
