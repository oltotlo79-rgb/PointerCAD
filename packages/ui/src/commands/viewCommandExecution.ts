import { FREE_WORK_PLANE_ID } from '@pointercad/model';
import type { EditToolReadiness } from '../sketch/editCommands.js';
import { assemblyToolbarIdle, explodeActionReadiness } from '../shell/menus/assemblyToolActions.js';
import { activateReferenceTool } from '../shell/menus/sketchToolActions.js';
import { PLANES, PLANE_TOOLS, REFERENCE_TOOLS, SNAP_KINDS_UI } from '../shell/menus/sketchToolDescriptors.js';
import { selectWorkPlane } from '../shell/menus/sketchToolTables.js';
import { useAppStore } from '../store/useAppStore.js';
import { VIEW_COMMAND_ITEMS } from './viewCommandItems.js';

export function runViewCommand(group: 'view' | 'plane' | 'reference' | 'snap' | 'assemblyUtility', source: string): EditToolReadiness {
  const state = useAppStore.getState();
  const ready: EditToolReadiness = { ready: true, reasonKey: null };
  const unavailable: EditToolReadiness = { ready: false, reasonKey: 'command.unavailable.action' };
  if (group === 'view') {
    const item = VIEW_COMMAND_ITEMS.find(item => item.id === source);
    if (item === undefined) return unavailable;
    switch (item.id) {
      case 'shaded': case 'shadedWithEdges': case 'wireframe': state.setDisplayStyle(item.id); return ready;
      case 'section': state.toggleSectionView(); return ready;
      case 'grid': state.setShowGrid(!state.showGrid); return ready;
      case 'chaining': state.setChaining(!state.chaining); return ready;
      case 'snap': state.setSnapEnabled(!state.snapEnabled); return ready;
      case 'home': state.requestHomeView(); return ready;
      case 'matchWorkPlane': state.requestMatchWorkPlaneToView(); return ready;
    }
  }
  if (group === 'plane') {
    if (source === 'free') { selectWorkPlane(FREE_WORK_PLANE_ID); return ready; }
    const plane = PLANES.find(plane => plane.id === source);
    if (plane === undefined) return unavailable;
    selectWorkPlane(plane.id); return ready;
  }
  if (group === 'reference') {
    const tools = [...PLANE_TOOLS, ...REFERENCE_TOOLS];
    const tool = tools.find(tool => tool.id === source);
    if (tool === undefined) return unavailable;
    activateReferenceTool(tool.id, state.activeTool === tool.id); return ready;
  }
  if (group === 'snap') {
    const item = SNAP_KINDS_UI.find(item => item.kind === source);
    if (item === undefined) return unavailable;
    if (!state.snapEnabled) return { ready: false, reasonKey: 'command.unavailable.snap' };
    state.toggleSnapKind(item.kind); return ready;
  }
  const assembly = state.assembly;
  if (assembly === null) return { ready: false, reasonKey: 'command.unavailable.assembly' };
  if (source === 'bom') {
    if (assembly.components.length === 0) return { ready: false, reasonKey: 'command.unavailable.bomComponents' };
    state.setSelection(['bom']); return ready;
  }
  if (state.isComputing) return { ready: false, reasonKey: 'command.unavailable.computing' };
  if (!assemblyToolbarIdle(state)) return { ready: false, reasonKey: 'command.unavailable.finishInput' };
  if (source === 'explode') {
    const readiness = explodeActionReadiness(assembly, state.selection);
    if (!readiness.ready) return readiness;
    return state.beginAssemblyExplode() ? ready : unavailable;
  }
  if (source === 'interference') {
    if (assembly.components.filter(item => item.visible && !item.suppressed).length < 2) {
      return { ready: false, reasonKey: 'command.unavailable.interferenceComponents' };
    }
    if (state.assemblyView?.sourceDocument !== assembly) return { ready: false, reasonKey: 'command.unavailable.geometry' };
    if (state.assemblyInterferenceRunner === null) return { ready: false, reasonKey: 'command.unavailable.interferencePreparing' };
    state.runAssemblyInterference(); return ready;
  }
  return unavailable;
}
