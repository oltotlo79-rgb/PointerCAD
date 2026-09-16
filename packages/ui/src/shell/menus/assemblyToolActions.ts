import { findComponent, type AssemblyDocument, type MateKind } from '@pointercad/model';
import type { AppState } from '../../store/appState.js';
import { useAppStore } from '../../store/useAppStore.js';
import type { EditToolReadiness } from '../../sketch/editCommands.js';
import { cancelMate, jointKindReadiness, mateKindReadiness, startJoint, startMate } from '../../assembly/mateActions.js';
import { startPlaceSubAssembly, startReplaceSelectedComponent } from '../../assembly/replaceActions.js';
import { startPlaceComponent, toggleSelectedFixed } from '../../assembly/placeComponentActions.js';
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
    && !state.isComputing && !state.assemblyReplacementBusy && state.assemblyReplacementPreview === null;
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
  return selected;
}

export function chooseAssemblyBuild(id: AssemblyMenuActionId): void {
  const state = useAppStore.getState();
  if (!assemblyBuildReadiness(state, id).ready) return;
  if (id === 'placePart') void startAssemblyPartPlacement();
  else if (id === 'placeStandardPart') state.openStandardPartPicker();
  else if (id === 'placeSubAssembly') void startPlaceSubAssembly();
  else if (id === 'replacePart') void startReplaceSelectedComponent();
  else toggleSelectedFixed();
}

export function chooseAssemblyMate(id: MateMenuAction): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  if (isMateMenuAction(id)) {
    if (mateKindReadiness(state, id).ready) startMate(id);
  } else if (jointKindReadiness(state, id).ready) startJoint(id);
}
