import { runViewCommand } from './viewCommandExecution.js';
import { DRAWING_TOOL_GROUPS, DRAWING_TABLE_ACTIONS, type DrawingToolbarAction } from '../drawing/drawingToolbarItems.js';
import { runDrawingToolbarAction } from '../drawing/drawingToolbarActions.js';
import { printDrawing } from '../drawing/printDrawing.js';
import { SHEET_METAL_MENU_ITEMS } from '../sheetMetal/sheetMetalMenuItems.js';
import { SCRIPT_MENU_ITEMS } from '../scripting/scriptMenuItems.js';
import { openScriptPanel } from '../scripting/scriptActions.js';
import { jointKindReadiness, mateKindReadiness } from '../assembly/mateActions.js';
import { cancelConstraintTool, chooseConstraintTool } from '../sketch/constraintActions.js';
import { solidToolReadiness } from '../solid/solidCommands.js';
import { subShapeBodiesOf } from '../solid/subShapeSelection.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { ASSEMBLY_MENU_ITEMS, MATE_MENU_ITEMS } from '../shell/menus/assemblyMenuItems.js';
import { assemblyBuildReadiness, chooseAssemblyBuild, chooseAssemblyMate, isMateMenuAction } from '../shell/menus/assemblyToolActions.js';
import { FILE_MENU_ITEMS } from '../shell/menus/fileMenuItems.js';
import { FILE_ACTIONS } from '../shell/menus/fileToolbarDescriptors.js';
import { runFileAction, runFileMenuAction } from '../shell/menus/fileToolbarActions.js';
import { LOOK_MENU_ITEMS, PROJECTION_MENU_ITEMS } from '../shell/menus/lookMenuItems.js';
import { chooseLookTool } from '../shell/menus/lookToolbarActions.js';
import { activateEditTool, activateShapeTool, activateTool } from '../shell/menus/sketchToolActions.js';
import { TOOLS } from '../shell/menus/sketchToolDescriptors.js';
import { CONSTRAINT_MENU_ITEMS, EDIT_MENU_ITEMS, SHAPE_MENU_ITEMS } from '../shell/menus/sketchMenuItems.js';
import { COMBINE_MENU_ITEMS, CREATE_MENU_ITEMS, MACHINING_MENU_ITEMS } from '../shell/menus/solidMenuItems.js';
import { runCombineTool, runSolidTool } from '../shell/menus/solidToolActions.js';
import { toolbarCommand } from './toolbarCommandCatalog.js';

/** Every entry calls the same action as its toolbar. Descriptors validate IDs before dispatch. */
export function runToolbarCommand(id: string): boolean {
  const command = toolbarCommand(id), state = useAppStore.getState();
  if (command === null || !command.documentKinds.includes(activeDocumentKind(state))) return false;
  const source = command.sourceId;
  switch (command.group) {
    case 'view': case 'plane': case 'reference': case 'snap': case 'assemblyUtility':
      return runViewCommand(command.group, source);
    case 'file': {
      const item = FILE_ACTIONS.find(entry => entry.id === source);
      if (item === undefined) return false;
      runFileAction(item.id, false); return true;
    }
    case 'fileMenu': {
      const item = FILE_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return false;
      runFileMenuAction(item.id,
        () => useAppStore.getState().setUtilityPanelOpen('export', true),
        () => useAppStore.getState().refreshTemplateEntries(),
        () => useAppStore.getState().setUtilityPanelOpen('import', true),
        () => useAppStore.getState().setUtilityPanelOpen('comparison', true));
      return true;
    }
    case 'sketch': {
      const item = TOOLS.find(entry => entry.id === source);
      if (item === undefined) return false;
      activateTool(item.id, state.activeTool === item.id); return true;
    }
    case 'shape': {
      const item = SHAPE_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return false;
      if (item.id === 'functionPlot') {
        state.setActiveTool('select'); state.setUtilityPanelOpen('functionPlot', true);
      } else activateShapeTool(item.id, state.activeTool === item.id);
      return true;
    }
    case 'edit': {
      const item = EDIT_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return false;
      activateEditTool(item.id, state.activeTool === item.id); return true;
    }
    case 'constraint': {
      const item = CONSTRAINT_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return false;
      if (state.activeConstraintKind === item.id) cancelConstraintTool(); else chooseConstraintTool(item.id);
      return true;
    }
    case 'solidCreate':
    case 'solidMachining': {
      const items = command.group === 'solidCreate' ? CREATE_MENU_ITEMS : MACHINING_MENU_ITEMS;
      const item = items.find(entry => entry.id === source);
      if (item === undefined) return false;
      const readiness = solidToolReadiness(state.document, state.selection, item.id, subShapeBodiesOf(state.bodies));
      // A missing selection starts the tool's selection step and displays its reason.
      runSolidTool(item.id, readiness); return true;
    }
    case 'solidCombine': {
      const item = COMBINE_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return false;
      const readiness = solidToolReadiness(state.document, state.selection, item.id, subShapeBodiesOf(state.bodies));
      runCombineTool(item.id, readiness); return readiness.ready;
    }
    case 'projection': {
      const item = PROJECTION_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return false;
      state.setProjection(item.id); return true;
    }
    case 'look': {
      const item = LOOK_MENU_ITEMS.find(entry => entry.id === source);
      return item !== undefined && chooseLookTool(item.id);
    }
    case 'assembly': {
      const item = ASSEMBLY_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined || !assemblyBuildReadiness(state, item.id).ready) return false;
      chooseAssemblyBuild(item.id); return true;
    }
    case 'sheetMetal': {
      const item = SHEET_METAL_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return false;
      if (state.sheetMetalTool?.kind === item.id) state.closeSheetMetalTool(); else state.openSheetMetalTool(item.id);
      return true;
    }
    case 'script': {
      if (!SCRIPT_MENU_ITEMS.some(item => item.id === source)) return false;
      openScriptPanel(); return true;
    }
    case 'drawing': {
      const actions: { readonly id: DrawingToolbarAction }[] = [...DRAWING_TABLE_ACTIONS];
      for (const group of DRAWING_TOOL_GROUPS) actions.push(...group.items);
      const item = actions.find(entry => entry.id === source);
      if (item === undefined || state.drawing === null || state.drawingBusy) return false;
      const panel = runDrawingToolbarAction(item.id);
      if (panel === 'print' && state.fileGateway.print === undefined) void printDrawing(1);
      else if (panel !== null) state.setUtilityPanelOpen(panel === 'print' ? 'drawingPrint' : 'drawingExport', true);
      return true;
    }
    case 'mate': {
      const item = MATE_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return false;
      const readiness = isMateMenuAction(item.id) ? mateKindReadiness(state, item.id) : jointKindReadiness(state, item.id);
      if (!readiness.ready) return false;
      chooseAssemblyMate(item.id); return true;
    }
  }
}
