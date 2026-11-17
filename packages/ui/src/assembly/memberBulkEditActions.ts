/**
 * 置いた後の部材の一括の書き換え(J-01 包み 8)の流れ。選んだ部品の計画(model の `planMemberBulkEdit`)を作り、
 * 合致・ジョイントが指していない時はそのまま 1 回で替える。指している時は、次の形を差し替えの計算
 * (`assemblyReplacementRunner`)で解いて部品ごとに選び直し(`planReplacement` を順に)、選び直せない物がある時だけ
 * 今の差し替えの予告(`ReplacementPopover`)に出す。確定は applyAssembly の 1 回(Undo 1 回)。店の欄は増やさない。
 */
import {
  buildStandardPartFromSource, findComponent, planMemberBulkEdit, planReplacement, type AssemblyDocument, type MemberBulkChange,
  type PartLibrary, type ReplacementPlan, type SolidBody, type StandardPartSource,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { beginDocumentRequest } from '../store/documentRequest.js';
import { useAppStore } from '../store/useAppStore.js';

/** 替えた・予告に出した部品の数、または替えなかった理由。 */
type MemberBulkOutcome =
  | { readonly kind: 'applied' | 'preview'; readonly count: number }
  | { readonly kind: 'refused'; readonly reason: string };

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  noSelection: 'catalog.memberBulk.reason.noSelection', notMember: 'catalog.memberBulk.reason.notMember',
  mixed: 'catalog.memberBulk.reason.mixed', unknownItem: 'catalog.memberBulk.reason.unknownItem',
  invalidOption: 'catalog.memberBulk.reason.invalidOption', noChange: 'catalog.memberBulk.reason.noChange',
  steelRow: 'catalog.memberBulk.reason.steelRow', unavailable: 'catalog.memberBulk.reason.unavailable',
};

/** 結果の 1 行の文字と役割(選ぶ窓の欄が出す)。 */
export function memberBulkMessage(outcome: MemberBulkOutcome): { readonly role: 'status' | 'alert'; readonly text: string } {
  if (outcome.kind === 'refused') return { role: 'alert', text: t(REASON_KEYS[outcome.reason] ?? 'catalog.memberBulk.reason.unavailable') };
  const key: MessageKey = outcome.kind === 'applied' ? 'catalog.memberBulk.applied' : 'catalog.memberBulk.previewed';
  return { role: 'status', text: t(key).replace('{count}', String(outcome.count)) };
}

const NO_ATTACHMENTS = { shapes: new Map(), meshes: new Map(), canvases: new Map() };

/** 計画の部品 1 つ(次の保存の形と名前)。 */
interface BulkEntry { readonly componentId: string; readonly nextSource: StandardPartSource; readonly nextName: string }

/** 次の保存の形と名前を部品に入れた文書(合致・ジョイントが指していない時)。 */
function replaceSources(assembly: AssemblyDocument, entries: readonly BulkEntry[]): AssemblyDocument {
  const next = new Map(entries.map((entry) => [entry.componentId, entry]));
  return { ...assembly, components: assembly.components.map((component) => {
    const entry = next.get(component.id);
    return entry === undefined ? component : { ...component, source: entry.nextSource, name: entry.nextName };
  }) };
}

/** 差し替えの計画(合致を選び直した文書)へ、計画の名前を入れる(名前は差し替えでは替わらないため)。 */
function renameComponents(assembly: AssemblyDocument, entries: readonly BulkEntry[]): AssemblyDocument {
  const names = new Map(entries.map((entry) => [entry.componentId, entry.nextName]));
  return { ...assembly, components: assembly.components.map((component) => {
    const name = names.get(component.id);
    return name === undefined || name === component.name ? component : { ...component, name };
  }) };
}

/** 次の形ごとに 1 回だけ解いた体(同じ保存の形の部品は同じ体を使う)。 */
async function resolvedBodies(entries: readonly { readonly nextSource: StandardPartSource }[], requestId: string):
Promise<ReadonlyMap<string, readonly SolidBody[]> | null> {
  const runner = useAppStore.getState().assemblyReplacementRunner;
  if (runner === null) return null;
  const bodies = new Map<string, readonly SolidBody[]>();
  for (const { nextSource } of entries) {
    const key = JSON.stringify(nextSource);
    if (bodies.has(key)) continue;
    const part = buildStandardPartFromSource(nextSource);
    if (part === null) return null;
    bodies.set(key, await runner.resolve(part, NO_ATTACHMENTS, requestId));
  }
  return bodies;
}

/** 部品ごとの差し替えを順に重ね、1 つの差し替えの計画にまとめる(予告と確定は今の差し替えの道)。 */
function combinedPlan(assembly: AssemblyDocument, entries: readonly BulkEntry[],
  bodies: ReadonlyMap<string, readonly SolidBody[]>): ReplacementPlan | null {
  let document = assembly;
  let matchedCount = 0, unmatchedCount = 0;
  const unresolvedIds: string[] = [];
  for (const entry of entries) {
    const plan = planReplacement(document, entry.componentId, entry.nextSource, { bodies: bodies.get(JSON.stringify(entry.nextSource)) ?? [] });
    if (plan === null) return null;
    document = plan.after;
    matchedCount += plan.matchedCount;
    unmatchedCount += plan.unmatchedCount;
    unresolvedIds.push(...plan.unresolvedIds);
  }
  const first = entries[0];
  if (first === undefined) return null;
  return { before: assembly, after: renameComponents(document, entries), componentId: first.componentId, nextSource: first.nextSource, matchedCount, unmatchedCount,
    affectedCount: matchedCount + unmatchedCount, unresolvedIds };
}

/** 替えた文書を 1 回で入れ、選択と選ぶ窓を残す(文書を入れると窓が閉じるため。一括配置と同じ)。 */
function applyKeepingPicker(document: AssemblyDocument, ids: readonly string[], library?: PartLibrary): void {
  const pickerOpen = useAppStore.getState().standardPartPickerOpen;
  useAppStore.getState().applyAssembly(document, library);
  useAppStore.getState().setSelection(ids);
  if (pickerOpen) useAppStore.setState({ standardPartPickerOpen: true });
}

/** 選んだ部品の行・長さを一括で替える。替えた時は Undo 1 回で戻る。 */
export async function startMemberBulkEdit(change: MemberBulkChange): Promise<MemberBulkOutcome> {
  const before = useAppStore.getState();
  const assembly = before.assembly;
  if (assembly === null || before.assemblyReplacementBusy) return { kind: 'refused', reason: 'unavailable' };
  const ids = before.selection.filter((id) => findComponent(assembly, id) !== undefined);
  const plan = planMemberBulkEdit(assembly, ids, change);
  if (!plan.ok) return { kind: 'refused', reason: plan.reason };
  if (plan.referencingCount === 0) {
    applyKeepingPicker(replaceSources(assembly, plan.entries), ids);
    return { kind: 'applied', count: plan.entries.length };
  }
  // 待つ前に共通の判定を始め、形を解いた後は、文書の切り替え・編集・取り消し・同じ操作の後の始めが無い時だけ当てる。
  const request = beginDocumentRequest('assembly.memberBulkEdit', before);
  const requestId = crypto.randomUUID(), documentId = before.activeDocumentId, library = before.assemblyLibrary;
  const current = (): boolean => {
    const state = useAppStore.getState();
    return request.isCurrent() && state.assemblyReplacementRequestId === requestId && state.activeDocumentId === documentId
      && state.assembly === assembly;
  };
  useAppStore.setState({ assemblyReplacementBusy: true, assemblyReplacementRequestId: requestId, assemblyReplacementPreview: null });
  try {
    const bodies = await resolvedBodies(plan.entries, requestId);
    const combined = bodies === null || !current() ? null : combinedPlan(assembly, plan.entries, bodies);
    if (combined === null) return { kind: 'refused', reason: 'unavailable' };
    if (combined.unmatchedCount === 0) {
      applyKeepingPicker(combined.after, ids, library);
      return { kind: 'applied', count: plan.entries.length };
    }
    useAppStore.setState({ assemblyReplacementPreview: { documentId, prepared: { plan: combined, requiresConfirmation: true }, library } });
    return { kind: 'preview', count: plan.entries.length };
  } catch {
    return { kind: 'refused', reason: 'unavailable' };
  } finally {
    if (useAppStore.getState().assemblyReplacementRequestId === requestId) {
      useAppStore.setState({ assemblyReplacementBusy: false, assemblyReplacementRequestId: null });
    }
  }
}
