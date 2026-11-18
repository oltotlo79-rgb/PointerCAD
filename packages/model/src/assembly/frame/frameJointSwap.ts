/**
 * 結合の入れ替え(E-13。設計 wip/e13-design.md §1): 記録のある接続(E-07 の記録)の板とつなぎ方を、別の候補へ替える純関数と、記録を外す純関数。
 * 記録の状態の判定(`frameJointRecordStatus`)と記録の接続の探し方(`recordedFrameJoint`)は、接合チェックも使うので frameJoints.ts に置く。
 *
 * - 入れ替えは 1 回の文書: 古い板・溝用のナット・ボルトを消し、新しい物を足し、記録を置き換える(記録の id と並びの位置は保つ)。
 *   候補は、古い部品を消した文書(`detachFrameJointRecord(..., true)`)で作る(古い部品が計画の邪魔をせず、部品の名前の連番も正しい)。
 * - 記録を外す: 置いた部品はそのまま残し、記録だけを消す(接合チェックは位置から判定する)。
 * - 当て推量で選ばない: 候補を選ぶのは呼ぶ側(利用者)。ここは選んだ候補で作るだけ。
 */
import { removeComponent } from '../assemblyEdit.js';
import type { AssemblyDocument } from '../types.js';
import { applyJointBracket, type JointBracketChoice, type JointBracketInputs } from './frameJointBrackets.js';
import type { FrameJointRecord } from './frameJointRecord.js';

/**
 * 記録を外した文書(`removeParts` の時は、記録の板・ナット・ボルトの部品も消す)。記録が無ければ文書をそのまま返す。
 * 部品を消すのは `removeComponent`(合致などの後始末も同じ)。記録が空になった欄は保存で書き出さない(io の読み書きの決まり)。
 */
export function detachFrameJointRecord(document: AssemblyDocument, recordId: string, removeParts: boolean): AssemblyDocument {
  const record = document.frameJoints?.find((candidate) => candidate.id === recordId);
  if (record === undefined) return document;
  const parts = removeParts ? [record.bracket.componentId, ...record.fastenerIds] : [];
  const removed = parts.reduce((next, id) => removeComponent(next, id), document);
  return { ...removed, frameJoints: (removed.frameJoints ?? []).filter((candidate) => candidate.id !== recordId) };
}

/** 入れ替えの結果。断る時は文書を変えずに理由(記録が無い・候補の計画が通らない)。 */
type FrameJointSwapResult =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[]; readonly record: FrameJointRecord }
  | { readonly ok: false; readonly reason: 'noRecord' } | { readonly ok: false; readonly result: JointBracketChoice['result'] };

/**
 * 記録の板とつなぎ方を、選んだ候補へ替える(1 回の文書。元に戻す 1 回で戻る)。`inputs` の接続は記録の接続(`recordedFrameJoint`)、
 * 候補は古い部品を消した文書で作った物を渡す。記録の id と並びの位置は保つ。
 */
export function swapFrameJointBracket(document: AssemblyDocument, recordId: string, inputs: JointBracketInputs, choice: JointBracketChoice):
FrameJointSwapResult {
  const records = document.frameJoints ?? [];
  const index = records.findIndex((candidate) => candidate.id === recordId);
  if (index < 0) return { ok: false, reason: 'noRecord' };
  const applied = applyJointBracket(detachFrameJointRecord(document, recordId, true), inputs, choice);
  if (!applied.ok) return { ok: false, result: applied.result };
  const record: FrameJointRecord = { ...applied.record, id: recordId };
  const others = (applied.document.frameJoints ?? []).filter((candidate) => candidate.id !== applied.record.id);
  return { ok: true, document: { ...applied.document, frameJoints: [...others.slice(0, index), record, ...others.slice(index)] },
    componentIds: applied.componentIds, record };
}
