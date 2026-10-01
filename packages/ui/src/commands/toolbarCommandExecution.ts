import { runViewCommand } from './viewCommandExecution.js';
import { DRAWING_TOOL_GROUPS, DRAWING_TABLE_ACTIONS, type DrawingToolbarAction } from '../drawing/drawingToolbarItems.js';
import { runDrawingToolbarAction } from '../drawing/drawingToolbarActions.js';
import { printDrawing } from '../drawing/printDrawing.js';
import { SHEET_METAL_MENU_ITEMS } from '../sheetMetal/sheetMetalMenuItems.js';
import { SCRIPT_MENU_ITEMS } from '../scripting/scriptMenuItems.js';
import { openScriptPanel } from '../scripting/scriptActions.js';
import { jointKindReadiness, mateKindReadiness } from '../assembly/mateActions.js';
import { cancelConstraintTool, chooseConstraintTool } from '../sketch/constraintActions.js';
import type { EditToolReadiness } from '../sketch/editCommands.js';
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
import { chooseLookTool, lookToolbarReadiness } from '../shell/menus/lookToolbarActions.js';
import { activateEditTool, activateShapeTool, activateTool } from '../shell/menus/sketchToolActions.js';
import { TOOLS } from '../shell/menus/sketchToolDescriptors.js';
import { CONSTRAINT_MENU_ITEMS, EDIT_MENU_ITEMS, SHAPE_MENU_ITEMS } from '../shell/menus/sketchMenuItems.js';
import { COMBINE_MENU_ITEMS, CREATE_MENU_ITEMS, MACHINING_MENU_ITEMS } from '../shell/menus/solidMenuItems.js';
import { runCombineTool, runSolidTool } from '../shell/menus/solidToolActions.js';
import { toolbarCommand } from './toolbarCommandCatalog.js';

export interface ToolbarCommandExecutionResult extends EditToolReadiness {
  /** The action has already published its complete failure message. */
  readonly feedback?: 'handled';
}

/** Boolean compatibility for callers that only need to know whether an action started. */
export function runToolbarCommand(id: string): boolean {
  return executeToolbarCommand(id).ready;
}

/** Toolbar actions expose their refusal reason to the shared command entry point. */
export function executeToolbarCommand(id: string): ToolbarCommandExecutionResult {
  const command = toolbarCommand(id), state = useAppStore.getState();
  const ready: EditToolReadiness = { ready: true, reasonKey: null };
  const unavailable: EditToolReadiness = { ready: false, reasonKey: 'command.unavailable.action' };
  if (command === null) return unavailable;
  if (!command.documentKinds.includes(activeDocumentKind(state))) return { ready: false, reasonKey: 'command.unavailable.document' };
  const source = command.sourceId;
  switch (command.group) {
    case 'view': case 'plane': case 'reference': case 'snap': case 'assemblyUtility':
      return runViewCommand(command.group, source);
    case 'file': {
      const item = FILE_ACTIONS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      runFileAction(item.id, false); return ready;
    }
    case 'fileMenu': {
      const item = FILE_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      runFileMenuAction(item.id,
        () => useAppStore.getState().setUtilityPanelOpen('export', true),
        () => useAppStore.getState().refreshTemplateEntries(),
        () => useAppStore.getState().setUtilityPanelOpen('import', true),
        () => useAppStore.getState().setUtilityPanelOpen('comparison', true));
      return ready;
    }
    case 'sketch': {
      const item = TOOLS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      activateTool(item.id, state.activeTool === item.id); return ready;
    }
    case 'shape': {
      const item = SHAPE_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      if (item.id === 'functionPlot') {
        state.setActiveTool('select'); state.setUtilityPanelOpen('functionPlot', true);
      } else activateShapeTool(item.id, state.activeTool === item.id);
      return ready;
    }
    case 'edit': {
      const item = EDIT_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      activateEditTool(item.id, state.activeTool === item.id); return ready;
    }
    case 'constraint': {
      const item = CONSTRAINT_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      if (state.activeConstraintKind === item.id) cancelConstraintTool(); else chooseConstraintTool(item.id);
      return ready;
    }
    case 'solidCreate':
    case 'solidMachining': {
      const items = command.group === 'solidCreate' ? CREATE_MENU_ITEMS : MACHINING_MENU_ITEMS;
      const item = items.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      const readiness = solidToolReadiness(state.document, state.selection, item.id, subShapeBodiesOf(state.bodies));
      // A missing selection starts the tool's selection step and displays its reason.
      runSolidTool(item.id, readiness); return ready;
    }
    case 'solidCombine': {
      const item = COMBINE_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      const readiness = solidToolReadiness(state.document, state.selection, item.id, subShapeBodiesOf(state.bodies));
      runCombineTool(item.id, readiness);
      // Keep the solid failure prefix supplied by runCombineTool and the status bar.
      return readiness.ready ? readiness : { ...readiness, feedback: 'handled' };
    }
    case 'projection': {
      const item = PROJECTION_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      state.setProjection(item.id); return ready;
    }
    case 'look': {
      const item = LOOK_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      const readiness = lookToolbarReadiness(state, item.id);
      return chooseLookTool(item.id) ? ready : readiness;
    }
    case 'assembly': {
      const item = ASSEMBLY_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      const readiness = assemblyBuildReadiness(state, item.id);
      if (!readiness.ready) return state.isComputing
        ? { ready: false, reasonKey: 'command.unavailable.computing' } : readiness;
      chooseAssemblyBuild(item.id); return ready;
    }
    case 'sheetMetal': {
      const item = SHEET_METAL_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      if (state.sheetMetalTool?.kind === item.id) state.closeSheetMetalTool(); else state.openSheetMetalTool(item.id);
      return ready;
    }
    case 'script': {
      if (!SCRIPT_MENU_ITEMS.some(item => item.id === source)) return unavailable;
      openScriptPanel(); return ready;
    }
    case 'drawing': {
      const actions: { readonly id: DrawingToolbarAction }[] = [...DRAWING_TABLE_ACTIONS];
      for (const group of DRAWING_TOOL_GROUPS) actions.push(...group.items);
      const item = actions.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      if (state.drawing === null) return { ready: false, reasonKey: 'command.unavailable.document' };
      if (state.drawingBusy) return { ready: false, reasonKey: 'command.unavailable.computing' };
      const panel = runDrawingToolbarAction(item.id);
      if (panel === 'print' && state.fileGateway.print === undefined) void printDrawing(1);
      else if (panel !== null) state.setUtilityPanelOpen(panel === 'print' ? 'drawingPrint' : 'drawingExport', true);
      return ready;
    }
    case 'mate': {
      const item = MATE_MENU_ITEMS.find(entry => entry.id === source);
      if (item === undefined) return unavailable;
      if (state.isComputing) return { ready: false, reasonKey: 'command.unavailable.computing' };
      if (state.assemblyPlacement !== null || state.assemblyDrag !== null
        || state.assemblyReplacementBusy || state.assemblyReplacementPreview !== null) {
        return { ready: false, reasonKey: 'command.unavailable.finishInput' };
      }
      const readiness = isMateMenuAction(item.id) ? mateKindReadiness(state, item.id) : jointKindReadiness(state, item.id);
      if (!readiness.ready) return readiness;
      chooseAssemblyMate(item.id); return ready;
    }
  }
}
