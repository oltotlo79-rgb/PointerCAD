/**
 * 配置の補助 P-A 寸法で動かすの打ちかけの純関数(伸縮 memberStretchDraft.ts と同じ形。状態は store の 1 か所に置き、ここは純関数だけ)。
 * - 欄: 動かす向き(世界の X・Y・Z、または成分で決めた斜めの向き。成分は式でよく、長さは問わず向きだけを使う)・基準(原点の面か、ほかの部品。
 *   部品は一覧から選ぶか、3D の画面で押す)・寸法の取り方(内側・芯・外側。P-B と同じ言葉)・寸法(mm。式でよい)。
 * - 選んだ部品はアルミフレーム・鋼材・機械要素・部品のファイルのどれでもよい。範囲は向きに沿って測る(partExtentAlong.ts。
 *   統括の決定 2026-11-19: 外接箱は丸い物・回した部品で大きく出るので使わない。世界の軸の向きも同じ測り方。式で測れる形は式の値で、
 *   式で測れない形を表示の網で測った時は、今の寸法の誤差の上限を予告に出す)。
 * - 予告: 今の寸法と、打った寸法にするための動かす量・動く部品の数(斜めの向きの時は向きと、数で書き換える座標。式が消える座標は
 *   その旨)、または断る理由。確定は予告と同じ入力で計画を作り直し、通った時だけ 1 回の文書で入れる。
 * - 1 回だけ動かす。拘束は残さない(残す時は距離の合致)。
 */
import { evaluateExpression } from '@pointercad/expression';
import {
  dimensionMeasureErrorMm, dimensionMoveUnitVector, measureComponentDimension, planDimensionMove, type AssemblyDocument, type DimensionMoveAxis,
  type DimensionMoveBasis,
  type DimensionMoveDirection, type DimensionMovePlan, type Vec3,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';
import { partExtentsAlong } from './partExtentAlong.js';

/** 向きの選択肢: 世界の X・Y・Z と、成分で決める斜めの向き('vector')。 */
export type DimensionMoveDirectionChoice = DimensionMoveAxis | 'vector';
export const DIMENSION_MOVE_DIRECTIONS: readonly DimensionMoveDirectionChoice[] = [0, 1, 2, 'vector'];
export const DIMENSION_MOVE_BASES: readonly DimensionMoveBasis[] = ['inner', 'center', 'outer'];
/** 基準の選択の値: 原点の面。ほかの値は基準の部品の id。 */
const ORIGIN_REFERENCE = 'origin';

export interface DimensionMoveDraft {
  readonly documentId: string;
  readonly componentId: string;
  /** 向き(世界の軸か、成分で決める 'vector')。 */
  readonly direction: DimensionMoveDirectionChoice;
  /** 斜めの向きの成分の入力の文字(X・Y・Z。式でよい)。向きが 'vector' の時だけ使う。 */
  readonly vector: readonly [string, string, string];
  /** 基準(ORIGIN_REFERENCE か部品の id)。 */
  readonly reference: string;
  readonly basis: DimensionMoveBasis;
  /** 寸法の入力の文字(式でよい)。 */
  readonly target: string;
}

export type DimensionMoveDraftPatch = Partial<Pick<DimensionMoveDraft, 'direction' | 'vector' | 'reference' | 'basis' | 'target'>>;

/**
 * 予告: 今の寸法(出せない時は null)と、断る前の入力の理由、または計画。斜めの向きは長さ 1 に直した向きも持つ。
 * meshErrorMm は今の寸法の誤差の上限(式で測れない形を表示の網で測った端を使った時だけ 0 より大きい。窓が印を出す)。
 */
export interface DimensionMovePreview {
  readonly current: number | null;
  readonly issue: 'stale' | 'noBox' | 'target' | 'vector' | 'badDirection' | null;
  readonly plan: DimensionMovePlan | null;
  readonly unit: Vec3 | null;
  readonly meshErrorMm: number;
}

/** 今の寸法を出す前に断る予告。 */
const blocked = (issue: 'stale' | 'noBox' | 'vector' | 'badDirection', unit: Vec3 | null = null): DimensionMovePreview =>
  ({ current: null, issue, plan: null, unit, meshErrorMm: 0 });

/** 打ちかけを作る(選んだ部品 1 つ。向きは X、成分は (1, 0, 0)、基準は原点の面、取り方は内側、寸法は空)。 */
export function createDimensionMoveDraft(documentId: string, componentId: string): DimensionMoveDraft {
  return { documentId, componentId, direction: 0, vector: ['1', '0', '0'], reference: ORIGIN_REFERENCE, basis: 'inner', target: '' };
}

/** 向きを替える欄。世界の軸から斜めへ替えた時は、成分をその軸の向きにして始める(続けて斜めにする成分だけを打てばよい)。 */
export function dimensionMoveDirectionPatch(draft: DimensionMoveDraft, direction: DimensionMoveDirectionChoice): DimensionMoveDraftPatch {
  if (direction !== 'vector' || draft.direction === 'vector') return { direction };
  const axis = draft.direction;
  return { direction, vector: [axis === 0 ? '1' : '0', axis === 1 ? '1' : '0', axis === 2 ? '1' : '0'] };
}

/** 成分の 1 つを替えた入力の文字。 */
export function withVectorComponent(vector: DimensionMoveDraft['vector'], axis: DimensionMoveAxis, text: string): DimensionMoveDraft['vector'] {
  return [axis === 0 ? text : vector[0], axis === 1 ? text : vector[1], axis === 2 ? text : vector[2]];
}

/** 入力の文字の値(式でよい)。読めない・有限でない時は null。 */
function numberOf(text: string): number | null {
  const result = evaluateExpression(text);
  return result.ok && Number.isFinite(result.value.value) ? result.value.value : null;
}

/** 打ちかけの向き。成分が読めない時は null。 */
function directionOf(draft: DimensionMoveDraft): DimensionMoveDirection | null {
  if (draft.direction !== 'vector') return { kind: 'axis', axis: draft.direction };
  const x = numberOf(draft.vector[0]), y = numberOf(draft.vector[1]), z = numberOf(draft.vector[2]);
  return x === null || y === null || z === null ? null : { kind: 'vector', vector: [x, y, z] };
}

/**
 * 予告。表示が古い・成分が読めない・向きの長さが 0・範囲が無い(今の寸法が出せない)・寸法が読めない時は理由。寸法が空なら今の寸法だけ。
 * 範囲は、動かす部品と基準の部品だけを、向きに沿って測る(式で測れる形は式の値、ほかは表示の網の値と誤差。partExtentAlong.ts)。
 */
export function previewDimensionMove(document: AssemblyDocument, view: AssemblyView, draft: DimensionMoveDraft): DimensionMovePreview {
  if (view.sourceDocument !== document) return blocked('stale');
  const direction = directionOf(draft);
  if (direction === null) return blocked('vector');
  const unit = dimensionMoveUnitVector(direction);
  if (unit === null) return blocked('badDirection');
  const reference = draft.reference === ORIGIN_REFERENCE ? { kind: 'origin' as const }
    : { kind: 'component' as const, componentId: draft.reference };
  const extents = partExtentsAlong(document, view, unit,
    reference.kind === 'component' ? [draft.componentId, reference.componentId] : [draft.componentId]);
  const request = { componentId: draft.componentId, direction, basis: draft.basis, reference };
  const current = measureComponentDimension(document, request, extents);
  if (current === null) return blocked('noBox', unit);
  const meshErrorMm = dimensionMeasureErrorMm(document, request, extents);
  if (draft.target.trim() === '') return { current, issue: null, plan: null, unit, meshErrorMm };
  const target = numberOf(draft.target);
  if (target === null) return { current, issue: 'target', plan: null, unit, meshErrorMm };
  return { current, issue: null, plan: planDimensionMove(document, { ...request, target }, extents), unit, meshErrorMm };
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

/** 3D の画面で押して基準にできる部品(基準の選択肢から原点の面を除いた物。窓の「3D で選ぶ」が頼みへ渡す候補)。 */
export function dimensionMovePickCandidates(document: AssemblyDocument, componentId: string): readonly string[] {
  return dimensionMoveReferences(document, componentId).filter((item) => item.value !== ORIGIN_REFERENCE).map((item) => item.value);
}
