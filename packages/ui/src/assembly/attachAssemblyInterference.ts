/** カーネルの干渉解析をストアへ接続し、2部品選択の隙間を表示する。 */
import type { AssemblyInterferenceInput, InterferenceKernelBridge } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import type { MeasurementState } from '../viewport/createMeasureLayer.js';
import { MEASURE_FAILED_MESSAGE_KEY } from '../solid/measure.js';
import { createAssemblyInterferenceRunner } from './interferenceActions.js';

function inputOf(state: AppState, requestId: string): AssemblyInterferenceInput | null {
  const document = state.assembly;
  const view = state.assemblyView;
  if (document === null || view === null || view.sourceDocument !== document) return null;
  const placements = state.assemblyMotionPlacements !== null
    && state.assemblyMotionSourceDocument === document
    ? state.assemblyMotionPlacements : view.resolved.placements;
  return {
    requestId,
    components: [...document.components],
    resolved: view.resolved,
    bodies: new Map(view.bodies),
    placements: new Map(placements),
  };
}

export function attachAssemblyInterference(bridge: InterferenceKernelBridge): () => void {
  const runner = createAssemblyInterferenceRunner(bridge);
  let detached = false;
  let generation = 0;
  let lastGap: MeasurementState | null = null;
  useAppStore.getState().setAssemblyInterferenceRunner(runner);

  function clearGap(state: AppState): void {
    if (lastGap !== null && state.measurement === lastGap) {
      useAppStore.setState({ measurement: null, massProperties: null });
    }
    lastGap = null;
  }

  function sync(state: AppState): void {
    generation += 1;
    const currentGeneration = generation;
    clearGap(state);
    const selected = state.selection.filter((id) =>
      state.assembly?.components.some((component) => component.id === id) === true);
    if (selected.length !== 2 || selected[0] === selected[1]) {
      if (state.assemblyGapRequestId !== null) useAppStore.setState({ assemblyGapRequestId: null });
      return;
    }
    const requestId = crypto.randomUUID();
    const input = inputOf(state, requestId);
    if (input === null) {
      if (state.assemblyGapRequestId !== null) useAppStore.setState({ assemblyGapRequestId: null });
      return;
    }
    useAppStore.setState({ assemblyGapRequestId: requestId });
    void runner.measureGap(input, selected[0], selected[1], state.displaySettings.lengthUnit)
      .then((measurement) => {
        if (detached || generation !== currentGeneration) return;
        const latest = useAppStore.getState();
        if (latest.assemblyGapRequestId !== requestId || latest.assembly !== state.assembly
          || latest.assemblyView !== state.assemblyView) return;
        lastGap = measurement;
        useAppStore.setState({ assemblyGapRequestId: null, measurement, massProperties: null,
          measureErrorKey: measurement === null ? MEASURE_FAILED_MESSAGE_KEY : null });
      }).catch(() => {
        if (detached || generation !== currentGeneration
          || useAppStore.getState().assemblyGapRequestId !== requestId) return;
        useAppStore.setState({ assemblyGapRequestId: null, measureErrorKey: MEASURE_FAILED_MESSAGE_KEY });
      });
  }

  const initial = useAppStore.getState();
  sync(initial);
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.assembly !== previous.assembly || next.assemblyView !== previous.assemblyView
      || next.selection !== previous.selection
      || next.assemblyMotionPlacements !== previous.assemblyMotionPlacements
      || next.assemblyMotionSourceDocument !== previous.assemblyMotionSourceDocument
      || next.displaySettings.lengthUnit !== previous.displaySettings.lengthUnit) sync(next);
  });

  return () => {
    detached = true;
    generation += 1;
    unsubscribe();
    const state = useAppStore.getState();
    clearGap(state);
    if (state.assemblyInterferenceRunner === runner) state.setAssemblyInterferenceRunner(null);
  };
}
