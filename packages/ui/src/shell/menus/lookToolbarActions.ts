import { appearanceReadiness } from '../../appearance/appearanceCommands.js';
import { measureToolReadiness } from '../../solid/measureCommands.js';
import { PRINT_CHECK_NO_BODY_KEY } from '../../solid/printCheckCommands.js';
import type { SolidToolReadiness } from '../../solid/solidCommands.js';
import { subShapeBodiesOf } from '../../solid/subShapeSelection.js';
import type { AppState } from '../../store/appState.js';
import { useAppStore } from '../../store/useAppStore.js';
import { addCanvasFromFile } from './lookToolActions.js';
import type { LookToolId } from './lookMenuItems.js';
import { runMeasureTool } from './solidToolActions.js';

/** Evaluate at activation time, including when a menu was opened before selection changed. */
export function lookToolbarReadiness(state: AppState, id: LookToolId): SolidToolReadiness {
  if (state.assembly !== null && id !== 'strength') return { ready: false, reasonKey: 'command.unavailable.document' };
  if (id === 'strength' || id === 'canvas') return { ready: true, reasonKey: null };
  // 図形の測定値(GR-30)。押せる条件は「部品を開いている」だけ(上の分岐で保証済み)。
  // 何も選んでいなくても押せる(§4(a) の P2)。
  if (id === 'mathGeometry') return { ready: true, reasonKey: null };
  const bodies = subShapeBodiesOf(state.bodies);
  if (id === 'measure') return measureToolReadiness(state.selection, bodies, state.isComputing ? undefined : state.resolvedSketch);
  if (id === 'printCheck') return bodies.length > 0
    ? { ready: true, reasonKey: null } : { ready: false, reasonKey: PRINT_CHECK_NO_BODY_KEY };
  const readiness = appearanceReadiness({ document: state.document, bodies, selection: state.selection,
    selectionKind: state.selectionKind, matches: state.appearanceMatches });
  return { ready: readiness.ok, reasonKey: readiness.reasonKey };
}

export function chooseLookTool(id: LookToolId): boolean {
  const state = useAppStore.getState(), readiness = lookToolbarReadiness(state, id);
  if (state.assembly !== null && id !== 'strength') return false;
  if (id === 'strength') { state.setActiveTool('select'); state.toggleStrength(); return true; }
  if (id === 'measure') { runMeasureTool(readiness); return readiness.ready; }
  if (id === 'canvas') { void addCanvasFromFile(); return true; }
  if (id === 'mathGeometry') {
    // 図形の測定値(GR-30)。専用の分岐: 同じ道具ならもう一度押して選択の道具へ戻し、
    // そうでなければこの道具へ切り替える。どちらも選択は消さない(§4(a))。
    state.setActiveTool(state.activeTool === id ? 'select' : id);
    state.requestViewportFocus();
    return true;
  }
  if (id === 'printCheck') {
    if (state.printability !== null) { state.setPrintability(null); return true; }
    state.inspectPrintability();
    return readiness.ready;
  }
  state.setActiveTool(state.activeTool === id ? 'select' : id);
  state.requestViewportFocus();
  if (!readiness.ready) state.setAppearanceError(readiness.reasonKey);
  return readiness.ready;
}
