import { FREE_WORK_PLANE_ID } from '@pointercad/model';
import { assemblyToolbarIdle, explodeActionReadiness } from '../shell/menus/assemblyToolActions.js';
import { activateReferenceTool } from '../shell/menus/sketchToolActions.js';
import { PLANES, PLANE_TOOLS, REFERENCE_TOOLS, SNAP_KINDS_UI } from '../shell/menus/sketchToolDescriptors.js';
import { selectWorkPlane } from '../shell/menus/sketchToolTables.js';
import { useAppStore } from '../store/useAppStore.js';
import { VIEW_COMMAND_ITEMS } from './viewCommandItems.js';

export function runViewCommand(group: 'view' | 'plane' | 'reference' | 'snap' | 'assemblyUtility', source: string): boolean {
  const state = useAppStore.getState();
  if (group === 'view') {
    const item = VIEW_COMMAND_ITEMS.find(item => item.id === source);
    if (item === undefined) return false;
    switch (item.id) {
      case 'shaded': case 'shadedWithEdges': case 'wireframe': state.setDisplayStyle(item.id); return true;
      case 'section': state.toggleSectionView(); return true;
      case 'grid': state.setShowGrid(!state.showGrid); return true;
      case 'chaining': state.setChaining(!state.chaining); return true;
      case 'snap': state.setSnapEnabled(!state.snapEnabled); return true;
      case 'home': state.requestHomeView(); return true;
      case 'matchWorkPlane': state.requestMatchWorkPlaneToView(); return true;
    }
  }
  if (group === 'plane') {
    if (source === 'free') { selectWorkPlane(FREE_WORK_PLANE_ID); return true; }
    const plane = PLANES.find(plane => plane.id === source);
    if (plane === undefined) return false;
    selectWorkPlane(plane.id); return true;
  }
  if (group === 'reference') {
    const tools = [...PLANE_TOOLS, ...REFERENCE_TOOLS];
    const tool = tools.find(tool => tool.id === source);
    if (tool === undefined) return false;
    activateReferenceTool(tool.id, state.activeTool === tool.id); return true;
  }
  if (group === 'snap') {
    const item = SNAP_KINDS_UI.find(item => item.kind === source);
    if (item === undefined || !state.snapEnabled) return false;
    state.toggleSnapKind(item.kind); return true;
  }
  const assembly = state.assembly;
  if (assembly === null) return false;
  if (source === 'bom') {
    if (assembly.components.length === 0) return false;
    state.setSelection(['bom']); return true;
  }
  if (!assemblyToolbarIdle(state)) return false;
  if (source === 'explode') {
    if (!explodeActionReadiness(assembly, state.selection).ready) return false;
    state.beginAssemblyExplode(); return true;
  }
  if (source === 'interference') {
    if (assembly.components.filter(item => item.visible && !item.suppressed).length < 2
      || state.assemblyView?.sourceDocument !== assembly || state.assemblyInterferenceRunner === null) return false;
    state.runAssemblyInterference(); return true;
  }
  return false;
}
