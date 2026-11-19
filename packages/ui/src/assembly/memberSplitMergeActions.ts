/**
 * 置いた部材の分割と統合(E-11)の流れ。選んだ部品から model の計画(`planMemberSplit`・`planMemberMerge`)を作り、作れた時は
 * 次の文書を 1 回で入れる(Undo 1 回で戻る)。結果の部材を選び、選ぶ窓は開いたままにする(一括の書き換えと同じ)。
 */
import { evaluateExpression } from '@pointercad/expression';
import {
  findComponent, mergeAccessorySets, planMemberMerge, planMemberSplit, splitAccessorySets, type AssemblyDocument, type MemberSplitMergeResult,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/** 分けた・まとめた結果(結果の長さ)か、何も変えなかった理由(指されている記録の数)。 */
type MemberSplitMergeOutcome =
  | { readonly kind: 'split' | 'merged'; readonly lengths: readonly number[] }
  | { readonly kind: 'refused'; readonly reason: string; readonly count: number | null };

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  noSelection: 'catalog.memberSplit.reason.noSelection', notOne: 'catalog.memberSplit.reason.notOne',
  badNumber: 'catalog.memberSplit.reason.badNumber', notMember: 'catalog.memberSplit.reason.notMember',
  mixed: 'catalog.memberSplit.reason.mixed', outOfRange: 'catalog.memberSplit.reason.outOfRange',
  invalidOption: 'catalog.memberSplit.reason.invalidOption', referenced: 'catalog.memberSplit.reason.referenced',
  notAligned: 'catalog.memberSplit.reason.notAligned', notTouching: 'catalog.memberSplit.reason.notTouching',
  miteredJoin: 'catalog.memberSplit.reason.miteredJoin', jointAtJoin: 'catalog.memberSplit.reason.jointAtJoin',
  unavailable: 'catalog.memberSplit.reason.unavailable', jointHasAccessory: 'catalog.memberSplit.reason.jointHasAccessory',
};

/**
 * 付属の組の記録の付け替え(A3): 分けた時は終点の付属を後ろの部材の記録へ移し、まとめた時は消える部材の記録を残す部材へまとめる。
 * まとめる端に付属があれば null(断る)。付属の置き直しは店が文書を入れる時に行う。
 */
function accessoriesAfter(before: AssemblyDocument | null, after: AssemblyDocument, componentIds: readonly string[], kind: 'split' | 'merged'):
AssemblyDocument | null {
  if (before === null || (after.accessorySets?.length ?? 0) === 0) return after;
  const [keptId, newId] = componentIds;
  if (keptId === undefined) return after;
  if (kind === 'split') return newId === undefined ? after : splitAccessorySets(after, keptId, newId);
  let document = after;
  for (const removed of before.components.filter((component) => findComponent(after, component.id) === undefined)) {
    const merged = mergeAccessorySets(document, keptId, removed.id);
    if (!merged.ok) return null;
    document = merged.document;
  }
  return document;
}

/** 結果の 1 行の文字と役割(選ぶ窓の欄が出す)。 */
export function memberSplitMergeMessage(outcome: MemberSplitMergeOutcome): { readonly role: 'status' | 'alert'; readonly text: string } {
  if (outcome.kind === 'refused') {
    return { role: 'alert', text: t(REASON_KEYS[outcome.reason] ?? 'catalog.memberSplit.reason.unavailable')
      .replace('{count}', String(outcome.count ?? 0)) };
  }
  const lengths = outcome.lengths.map((length) => String(length));
  return outcome.kind === 'split'
    ? { role: 'status', text: t('catalog.memberSplit.split').replace('{first}', lengths[0] ?? '').replace('{second}', lengths[1] ?? '') }
    : { role: 'status', text: t('catalog.memberSplit.merged').replace('{length}', lengths[0] ?? '') };
}

/** 今選んでいる部品(アセンブリの部品だけ)。 */
function selectedComponents(): readonly string[] {
  const state = useAppStore.getState();
  const assembly = state.assembly;
  return assembly === null ? [] : state.selection.filter((id) => findComponent(assembly, id) !== undefined);
}

/** 計画を入れ、結果の部材を選び、選ぶ窓を残す(文書を入れると窓が閉じるため)。 */
function applyPlan(plan: MemberSplitMergeResult, kind: 'split' | 'merged'): MemberSplitMergeOutcome {
  if (!plan.ok) return { kind: 'refused', reason: plan.reason, count: plan.count };
  const document = accessoriesAfter(useAppStore.getState().assembly, plan.document, plan.componentIds, kind);
  if (document === null) return { kind: 'refused', reason: 'jointHasAccessory', count: null };
  const pickerOpen = useAppStore.getState().standardPartPickerOpen;
  useAppStore.getState().applyAssembly(document);
  useAppStore.getState().setSelection(plan.componentIds);
  if (pickerOpen) useAppStore.setState({ standardPartPickerOpen: true });
  return { kind, lengths: plan.lengths };
}

/** 選んだ部材 1 本を、始点の端から distanceText(式でよい。mm)の所で 2 本に分ける。 */
export function splitSelectedMember(distanceText: string): MemberSplitMergeOutcome {
  const assembly = useAppStore.getState().assembly;
  const ids = selectedComponents();
  if (assembly === null || useAppStore.getState().isComputing) return { kind: 'refused', reason: 'unavailable', count: null };
  if (ids.length === 0) return { kind: 'refused', reason: 'noSelection', count: null };
  const [id] = ids;
  if (ids.length !== 1 || id === undefined) return { kind: 'refused', reason: 'notOne', count: null };
  const distance = evaluateExpression(distanceText);
  if (!distance.ok || !Number.isFinite(distance.value.value)) return { kind: 'refused', reason: 'badNumber', count: null };
  return applyPlan(planMemberSplit(assembly, id, distance.value.value), 'split');
}

/** 選んだ部材(2 本以上)を 1 本にまとめる。 */
export function mergeSelectedMembers(): MemberSplitMergeOutcome {
  const assembly = useAppStore.getState().assembly;
  if (assembly === null || useAppStore.getState().isComputing) return { kind: 'refused', reason: 'unavailable', count: null };
  return applyPlan(planMemberMerge(assembly, selectedComponents()), 'merged');
}
