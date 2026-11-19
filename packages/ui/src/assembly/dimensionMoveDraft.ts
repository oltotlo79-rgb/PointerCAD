/**
 * 配置の補助 P-A 寸法で動かすの打ちかけの純関数(伸縮 memberStretchDraft.ts と同じ形。状態は store の 1 か所に置き、ここは純関数だけ)。
 * - 欄: 動かす向き(世界の X・Y・Z)・基準(原点の面か、ほかの部品)・寸法の取り方(内側・芯・外側。P-B と同じ言葉)・寸法(mm。式でよい)。
 * - 選んだ部品はアルミフレーム・鋼材・機械要素・部品のファイルのどれでもよい(外接箱は表示の形から作る。接合チェック・伸縮と同じ作り方)。
 * - 予告: 今の寸法と、打った寸法にするための動かす量・動く部品の数、または断る理由。確定は予告と同じ入力で計画を作り直し、通った時だけ 1 回の文書で入れる。
 * - 1 回だけ動かす。拘束は残さない(残す時は距離の合致)。
 */
import { evaluateExpression } from '@pointercad/expression';
import {
  measureComponentDimension, planDimensionMove, type AssemblyDocument, type DimensionMoveAxis, type DimensionMoveBasis, type DimensionMovePlan,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';
import { assemblyPartBoxes } from './frameJointCheckView.js';

export const DIMENSION_MOVE_AXES: readonly DimensionMoveAxis[] = [0, 1, 2];
export const DIMENSION_MOVE_BASES: readonly DimensionMoveBasis[] = ['inner', 'center', 'outer'];
/** 基準の選択の値: 原点の面。ほかの値は基準の部品の id。 */
const ORIGIN_REFERENCE = 'origin';

export interface DimensionMoveDraft {
  readonly documentId: string;
  readonly componentId: string;
  readonly axis: DimensionMoveAxis;
  /** 基準(ORIGIN_REFERENCE か部品の id)。 */
  readonly reference: string;
  readonly basis: DimensionMoveBasis;
  /** 寸法の入力の文字(式でよい)。 */
  readonly target: string;
}

export type DimensionMoveDraftPatch = Partial<Pick<DimensionMoveDraft, 'axis' | 'reference' | 'basis' | 'target'>>;

/** 予告: 今の寸法(出せない時は null)と、断る前の入力の理由、または計画。 */
export interface DimensionMovePreview {
  readonly current: number | null;
  readonly issue: 'stale' | 'noBox' | 'target' | null;
  readonly plan: DimensionMovePlan | null;
}

/** 打ちかけを作る(選んだ部品 1 つ。向きは X、基準は原点の面、取り方は内側、寸法は空)。 */
export function createDimensionMoveDraft(documentId: string, componentId: string): DimensionMoveDraft {
  return { documentId, componentId, axis: 0, reference: ORIGIN_REFERENCE, basis: 'inner', target: '' };
}

/** 入力の文字の値(式でよい)。読めない・有限でない時は null。 */
function numberOf(text: string): number | null {
  const result = evaluateExpression(text);
  return result.ok && Number.isFinite(result.value.value) ? result.value.value : null;
}

/** 予告。表示が古い・箱が無い(今の寸法が出せない)・寸法が読めない時は理由。寸法が空なら今の寸法だけ。 */
export function previewDimensionMove(document: AssemblyDocument, view: AssemblyView, draft: DimensionMoveDraft): DimensionMovePreview {
  if (view.sourceDocument !== document) return { current: null, issue: 'stale', plan: null };
  const boxes = assemblyPartBoxes(document, view);
  const request = { componentId: draft.componentId, axis: draft.axis, basis: draft.basis,
    reference: draft.reference === ORIGIN_REFERENCE ? { kind: 'origin' as const } : { kind: 'component' as const, componentId: draft.reference } };
  const current = measureComponentDimension(document, request, boxes);
  if (current === null) return { current: null, issue: 'noBox', plan: null };
  if (draft.target.trim() === '') return { current, issue: null, plan: null };
  const target = numberOf(draft.target);
  if (target === null) return { current, issue: 'target', plan: null };
  return { current, issue: null, plan: planDimensionMove(document, { ...request, target }, boxes) };
}

/** 確定を押せるか(予告の計画が通る時だけ)。 */
export function dimensionMoveReady(preview: DimensionMovePreview | null): boolean {
  return preview?.plan?.ok === true;
}

/** 基準の選択肢: 原点の面と、動かす部品の組の外の、抑制していない部品(並びは文書の順)。 */
export function dimensionMoveReferences(document: AssemblyDocument, componentId: string): readonly { readonly value: string;
  readonly name: string | null }[] {
  const group = document.components.find((candidate) => candidate.id === componentId)?.rigidGroupId;
  const others = document.components.filter((candidate) => candidate.id !== componentId && !candidate.suppressed
    && (group === undefined || group === '' || candidate.rigidGroupId !== group));
  return [{ value: ORIGIN_REFERENCE, name: null }, ...others.map((candidate) => ({ value: candidate.id, name: candidate.name }))];
}
