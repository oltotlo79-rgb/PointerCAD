import { findComponent, releaseRigidGroup, rigidGroupsOf, type AssemblyDocument, type MateKind } from '@pointercad/model';
import type { AppState } from '../../store/appState.js';
import { useAppStore } from '../../store/useAppStore.js';
import type { EditToolReadiness } from '../../sketch/editCommands.js';
import { cancelMate, jointKindReadiness, mateKindReadiness, startJoint, startMate } from '../../assembly/mateActions.js';
import { startPlaceSubAssembly, startReplaceSelectedComponent } from '../../assembly/replaceActions.js';
import { startPlaceComponent, toggleSelectedFixed } from '../../assembly/placeComponentActions.js';
import { selectedWeldId } from '../../assembly/filletWeldDraft.js';
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
    && state.assemblyBoltedJointDraft === null && state.assemblyFilletWeldDraft === null;
}

export function assemblyBuildReadiness(state: AppState, id: AssemblyMenuActionId): EditToolReadiness {
  if (state.assembly === null) return { ready: false, reasonKey: 'command.unavailable.assembly' };
  const idle = assemblyToolbarIdle(state), selected = assemblyActionReadiness(state.assembly, state.selection);
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
  if (id === 'releaseFastening') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    return selectedFastening(state.assembly, state.selection) !== null
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.boltedJoint.selectFastened' };
  }
  if (id === 'filletWeld') {
    if (!idle) return { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    // ビードを1つ選んでいれば、その溶接を直す。それ以外は新しい溶接(抑制していない部品が2つ要る)。
    if (selectedWeldId(state.assembly, state.selection) !== null) return { ready: true, reasonKey: null };
    return state.assembly.components.filter((component) => !component.suppressed).length >= 2
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.filletWeld.needTwoComponents' };
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
  else if (id === 'placeStandardPart') state.openStandardPartPicker();
  else if (id === 'placeSubAssembly') void startPlaceSubAssembly();
  else if (id === 'replacePart') void startReplaceSelectedComponent();
  else if (id === 'boltedJoint') {
    // cancelMate は選択も消すので、締結した部品を選んで開く「直す」のために、その前の選択を渡す。
    const selection = state.selection;
    cancelMate();
    useAppStore.getState().beginBoltedJoint(selection);
  }
  else if (id === 'releaseFastening') {
    const group = state.assembly === null ? null : selectedFastening(state.assembly, state.selection);
    // 解除は組の印を外すだけで配置は変えない。1 回が Undo の 1 段。
    if (state.assembly !== null && group !== null) state.applyAssembly(releaseRigidGroup(state.assembly, group));
  } else if (id === 'filletWeld') {
    // 選んでいるビードから直す下書きを作るので、選択を消す cancelMate より先に始める(合致の打ちかけが無いことは
    // 上の準備の判定 idle で確かめ済み)。始めた後は他の道具と同じく選択と強調を消す。
    if (state.beginFilletWeld()) cancelMate();
  }
  else toggleSelectedFixed();
}

export function chooseAssemblyMate(id: MateMenuAction): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  if (isMateMenuAction(id)) {
    if (mateKindReadiness(state, id).ready) startMate(id);
  } else if (jointKindReadiness(state, id).ready) startJoint(id);
}
