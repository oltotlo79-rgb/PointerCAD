import { findComponent, frameSlotCandidates, releaseRigidGroup, rigidGroupsOf, type AssemblyDocument, type MateKind } from '@pointercad/model';
import type { AppState } from '../../store/appState.js';
import { useAppStore } from '../../store/useAppStore.js';
import type { EditToolReadiness } from '../../sketch/editCommands.js';
import { cancelMate, jointKindReadiness, mateKindReadiness, startJoint, startMate } from '../../assembly/mateActions.js';
import { startPlaceSubAssembly, startReplaceSelectedComponent } from '../../assembly/replaceActions.js';
import { startCreatePart, startPlaceComponent, toggleSelectedFixed } from '../../assembly/placeComponentActions.js';
import { selectedWeldId } from '../../assembly/filletWeldDraft.js';
import { selectedCircularWeldId } from '../../store/circularWeldActions.js';
import { selectedJointRecordId } from '../../assembly/frameJointBracketDraft.js';
import type { AssemblyMenuActionId, MateMenuAction } from './assemblyMenuItems.js';

export function isMateMenuAction(id: MateMenuAction): id is MateKind {
  switch (id) {
    case 'coincident':
    case 'concentric':
    case 'distance':
    case 'angle':
    case 'parallel':
    case 'tangent':
      return true;
    case 'revolute':
    case 'slider':
    case 'cylindrical':
    case 'ball':
      return false;
  }
}

export function startAssemblyPartPlacement(deps?: Parameters<typeof startPlaceComponent>[0]): Promise<void> {
  useAppStore.getState().cancelCircularWeld();
  cancelMate();
  return startPlaceComponent(deps);
}

export function assemblyActionReadiness(
  assembly: AssemblyDocument,
  selection: readonly string[],
): EditToolReadiness {
  const components = selection.filter((id) => findComponent(assembly, id) !== undefined);
  return components.length === 1
    ? { ready: true, reasonKey: null }
    : { ready: false, reasonKey: 'assembly.tool.selectOneComponentReason' };
}

export function explodeActionReadiness(
  assembly: AssemblyDocument,
  selection: readonly string[],
): EditToolReadiness {
  return selection.some((id) => findComponent(assembly, id) !== undefined)
    ? { ready: true, reasonKey: null }
    : { ready: false, reasonKey: 'assembly.explode.selectComponent' };
}

export function assemblyToolbarIdle(state: AppState): boolean {
  return state.assemblyPlacement === null && state.assemblyMateDraft === null && state.assemblyDrag === null
    && !state.isComputing && !state.assemblyReplacementBusy && state.assemblyReplacementPreview === null
    && state.assemblyBoltedJointDraft === null && state.assemblyFilletWeldDraft === null && state.assemblyCircularWeldDraft === null
    && state.assemblyFrameSlotDraft === null && state.assemblyJointBracketDraft === null
    && state.assemblyMemberStretchDraft === null;
}

/**
 * assemblyToolbarIdle に入っていない窓と下書き(規格部品の窓・辺の選択・寸法移動・分解・入れ子の締結と溶接・子の溶接の編集)が、
 * どれも開いていない。部品を作る時に、置く窓をこれらと重ねないために見る。
 * 部品を置く(placePart)には使わない: 今はこれらが開いていても置けるので、使うと押せる条件が変わる。
 */
function assemblySideOperationsIdle(state: AppState): boolean {
  return !state.standardPartPickerOpen && state.frameEdgePick === null
    && state.assemblyDimensionMoveDraft === null && state.assemblyExplodeDraft === null
    && state.assemblyNestedBoltDraft === null && state.assemblyNestedWeldDraft === null && state.assemblyChildWeldEdit === null;
}

/** 組立の溝つきのフレームの部品(表示の解が無い時は無い)。フレームの溝に締結する道具の押せる条件とブラケットの見分けに使う。 */
function frameSlotFrameIds(state: AppState): ReadonlySet<string> {
  return new Set(state.assembly === null || state.assemblyView === null ? []
    : frameSlotCandidates(state.assembly, state.assemblyView.resolved.placements).map((candidate) => candidate.componentId));
}

export function assemblyBuildReadiness(state: AppState, id: AssemblyMenuActionId): EditToolReadiness {
  if (state.assembly === null) return { ready: false, reasonKey: 'command.unavailable.assembly' };
  const idle = assemblyToolbarIdle(state), selected = assemblyActionReadiness(state.assembly, state.selection);
  if (id === 'createPart') return idle && assemblySideOperationsIdle(state)
    ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.tool.createPartBusy' };
  if (id === 'placePart') return state.assemblyPlacement === null && !state.assemblyReplacementBusy
    ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.tool.placementBusy' };
  if (id === 'placeStandardPart' || id === 'placeSubAssembly') return idle
    ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.tool.placementBusy' };
  if (id === 'replacePart') return idle && state.assemblyReplacementRunner !== null
    ? selected : { ready: false, reasonKey: 'assembly.tool.placementBusy' };
  if (id === 'boltedJoint') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    return state.assembly.components.filter((component) => !component.suppressed).length >= 2
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.boltedJoint.needTwoComponents' };
  }
  if (id === 'frameSlotFastening') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    return frameSlotFrameIds(state).size > 0
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.frameSlot.needFrame' };
  }
  if (id === 'releaseFastening') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    return selectedFastening(state.assembly, state.selection) !== null
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.boltedJoint.selectFastened' };
  }
  if (id === 'filletWeld' || id === 'circularFilletWeld') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    // ビードを1つ選んでいれば、その溶接を直す。それ以外は新しい溶接(抑制していない部品が2つ要る)。
    if (selectedCircularWeldId(state.assembly, state.selection) !== null
      || (id === 'filletWeld' && selectedWeldId(state.assembly, state.selection) !== null)) return { ready: true, reasonKey: null };
    return state.assembly.components.filter((component) => !component.suppressed).length >= 2
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.filletWeld.needTwoComponents' };
  }
  if (id === 'jointCheck') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    // 一覧は表示中の配置から作るので、組立の形の解が今の文書の物である事が要る(干渉を調べると同じ)。
    return state.assemblyView?.sourceDocument === state.assembly
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'command.unavailable.geometry' };
  }
  if (id === 'jointSwap') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    return selectedJointRecordId(state.assembly, state.selection) !== null
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.jointSwap.selectBracket' };
  }
  if (id === 'dimensionMove') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    // アルミフレーム・鋼材・機械要素・部品のファイルのどれでも、部品を 1 つ選んでいれば使える(配置の補助 P-A)。
    return state.assemblyView?.sourceDocument === state.assembly && state.selection.length === 1
      && state.assembly.components.some((component) => component.id === state.selection[0])
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.dimensionMove.selectComponent' };
  }
  if (id === 'memberStretch') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    return state.assemblyView?.sourceDocument === state.assembly && state.assembly.components.length > 0
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'command.unavailable.geometry' };
  }
  return selected;
}

/** 選んだ部品 1 つが属する締結の組(2 部品以上)の id。無ければ `null`。 */
export function selectedFastening(assembly: AssemblyDocument, selection: readonly string[]): string | null {
  const components = selection.flatMap((id) => {
    const component = findComponent(assembly, id);
    return component === undefined ? [] : [component];
  });
  const group = components.length === 1 ? components[0]?.rigidGroupId : undefined;
  if (group === undefined || group === '') return null;
  return rigidGroupsOf(assembly).has(group) ? group : null;
}

export function chooseAssemblyBuild(id: AssemblyMenuActionId): void {
  const state = useAppStore.getState();
  if (!assemblyBuildReadiness(state, id).ready) return;
  if (id === 'placePart') void startAssemblyPartPlacement();
  else if (id === 'createPart') startCreatePart();
  else if (id === 'placeStandardPart') state.openStandardPartPicker();
  else if (id === 'placeSubAssembly') void startPlaceSubAssembly();
  else if (id === 'replacePart') void startReplaceSelectedComponent();
  else if (id === 'boltedJoint') {
    // cancelMate は選択も消すので、締結した部品を選んで開く「直す」のために、その前の選択を渡す。
    const selection = state.selection;
    cancelMate();
    useAppStore.getState().beginBoltedJoint(selection);
  }
  else if (id === 'frameSlotFastening') {
    // 溝つきのフレームでない選んだ部品をブラケットとして渡す(P7)。無ければ穴を選ぶ形(P6b)。
    const frames = frameSlotFrameIds(state);
    const brackets = state.selection.filter((selected) => !frames.has(selected)
      && state.assembly?.components.some((component) => component.id === selected) === true);
    cancelMate();
    useAppStore.getState().beginFrameSlotFastening(brackets.length > 0 ? brackets : null);
  }
  else if (id === 'releaseFastening') {
    const group = state.assembly === null ? null : selectedFastening(state.assembly, state.selection);
    // 解除は組の印を外すだけで配置は変えない。1 回が Undo の 1 段。
    if (state.assembly !== null && group !== null) state.applyAssembly(releaseRigidGroup(state.assembly, group));
  } else if (id === 'circularFilletWeld') {
    if (state.beginCircularWeld()) cancelMate();
  } else if (id === 'filletWeld') {
    // 選んでいるビードから直す下書きを作るので、選択を消す cancelMate より先に始める(合致の打ちかけが無いことは
    // 上の準備の判定 idle で確かめ済み)。始めた後は他の道具と同じく選択と強調を消す。
    if (state.beginFilletWeld()) cancelMate();
  }
  else if (id === 'jointCheck') state.openAssemblyJointCheck();
  else if (id === 'jointSwap') {
    // 記録の接続が今の組立に無い(部材が動いた・長さが変わった)時は、理由と「記録を外す」が出る接合チェックの一覧を開く。
    const recordId = state.assembly === null ? null : selectedJointRecordId(state.assembly, state.selection);
    if (recordId !== null && !state.beginJointBracketSwap(recordId)) state.openAssemblyJointCheck();
  }
  else if (id === 'memberStretch') state.beginMemberStretch();
  else if (id === 'dimensionMove') state.beginDimensionMove();
  else toggleSelectedFixed();
}

export function chooseAssemblyMate(id: MateMenuAction): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  if (isMateMenuAction(id)) {
    if (mateKindReadiness(state, id).ready) startMate(id);
  } else if (jointKindReadiness(state, id).ready) startJoint(id);
}
