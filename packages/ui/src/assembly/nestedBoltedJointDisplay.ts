import type { JointOccurrencePath } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { BoltedJointDraftPreview, BoltedJointPickTarget } from './boltedJointDraft.js';
import type { NestedBoltedJointDraft, NestedBoltedJointPick, NestedBoltedJointPreview } from './nestedBoltedJointDraft.js';

/**
 * 根の葉を先に選んだ締結の平らな選択を、根からの経路 [部品] の入れ子の選択へ移す。部品の鍵は今の解いた組立から取る。
 * 鍵の無い部品・基準ジオメトリ(原点・軸・平面)の選択は移さない(null。文書と下書きは変えない)。
 */
export function rootBoltedJointPicks(
  picks: readonly BoltedJointPickTarget[], partKeys: ReadonlyMap<string, string>,
): NestedBoltedJointPick[] | null {
  const carried: NestedBoltedJointPick[] = [];
  for (const target of picks) {
    const partKey = partKeys.get(target.componentId);
    if (partKey === undefined) return null;
    const path: JointOccurrencePath = [target.componentId];
    if (target.kind === 'subShape') carried.push({ kind: 'jointOccurrence', path, partKey, ref: target.ref });
    else if (target.kind === 'modeledThreadGroup') carried.push({ kind: 'modeledThreadGroup', path, partKey, group: target.group });
    else return null;
  }
  return carried;
}

/** 入れ子の締結で次に選ぶのが穴か(穴A・合わせ面A・穴B・合わせ面B の順。平らの boltedJointHoleSlotActive と同じ規則)。 */
export function nestedBoltedJointHoleSlotActive(draft: NestedBoltedJointDraft): boolean {
  return draft.picks.length < 4 && draft.picks.length % 2 === 0;
}

/**
 * 入れ子の締結の予告を、締結の窓と状態欄が読む今の予告の形へ写す(窓と状態欄の文言・翻訳はそのまま使う)。
 * 今の締結の課題(選ぶ数・面でない・穴が分からない・欄・古い)と、計画の断りの一覧はそのまま。経路の解決・部品の鍵の
 * 変化・選ぶ順・文書の食い違い、理由だけの命令の断りは、まだ専用の文言が無いので「形が古い」として見せる。
 */
/**
 * 入れ子の締結だけの断り(選ぶ順・文書の食い違い・部品の版の変化・経路の解決・理由の無い命令の断り)の文言の鍵。
 * 今の締結の課題と計画の断りは今の窓・状態欄の文言で出すので null。
 */
export function nestedBoltedJointRefusalKey(preview: NestedBoltedJointPreview | null): MessageKey | null {
  if (preview === null) return null;
  if (preview.kind === 'issue') {
    switch (preview.issue.kind) {
      case 'invalidPicks': return 'assembly.boltedJoint.nested.order';
      case 'documentMismatch': return 'assembly.boltedJoint.nested.document';
      case 'partKeyChanged': return 'assembly.boltedJoint.nested.partKey';
      case 'occurrence': return 'assembly.boltedJoint.nested.occurrence';
      default: return null;
    }
  }
  return !preview.result.ok && preview.result.rejections.length === 0 ? 'assembly.boltedJoint.nested.command' : null;
}

export function nestedBoltedJointDisplayPreview(preview: NestedBoltedJointPreview | null): BoltedJointDraftPreview | null {
  if (preview === null) return null;
  if (preview.kind === 'issue') {
    const issue = preview.issue;
    return issue.kind === 'needPicks' || issue.kind === 'notFace' || issue.kind === 'holeFeatureUnknown'
      || issue.kind === 'value' || issue.kind === 'stale'
      ? { kind: 'issue', issue } : { kind: 'issue', issue: { kind: 'stale' } };
  }
  const result = preview.result;
  if (result.ok) return { kind: 'plan', result: { ok: true, plan: result.plan } };
  return result.rejections.length > 0 ? { kind: 'plan', result: { ok: false, rejections: result.rejections } }
    : { kind: 'issue', issue: { kind: 'stale' } };
}
