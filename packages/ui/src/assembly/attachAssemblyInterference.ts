/** カーネルの干渉解析をストアへ接続し、2部品選択の隙間を表示する。 */
import type { AssemblyInterferenceInput, InterferenceKernelBridge, LengthUnit } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import type { MeasurementState } from '../viewport/createMeasureLayer.js';
import { MEASURE_FAILED_MESSAGE_KEY } from '../solid/measure.js';
import { createAssemblyInterferenceRunner } from './interferenceActions.js';

/**
 * 隙間の測定の返事を待つ上限(ms)。実測(2026-11-17、溝つきの 20 角の部材 2 本・面 44 ずつ、重なる・接する・離れる)の
 * 最も遅い 0.47 秒の約 20 倍。超えたら待つのをやめて文を出す(Worker の計算は止まらないので、終わるまで次は流さない)。
 */
const GAP_MEASURE_TIMEOUT_MS = 10_000;

type AssemblyView = NonNullable<AppState['assemblyView']>;

/**
 * 隙間の測定の結果を変え得る物の全部。表示の所有(meshOwnership)だけの差し替えはここに入らない
 * (測定の頼みが受領の世代を進め、表示が所有を取り直して assemblyView を差し替えても、測り直さない)。
 */
interface GapInputs {
  readonly document: NonNullable<AppState['assembly']>;
  readonly sourceDocument: AssemblyView['sourceDocument'];
  readonly resolved: AssemblyView['resolved'];
  readonly bodies: AssemblyView['bodies'];
  readonly placements: AssemblyInterferenceInput['placements'];
  readonly motionPlacements: AppState['assemblyMotionPlacements'];
  readonly motionSourceDocument: AppState['assemblyMotionSourceDocument'];
  readonly pair: readonly [string, string];
  readonly unit: LengthUnit;
}

/** 今の状態の測る中身。2 部品の選択でない時・表示の解が今の文書のものでない時は null。 */
function gapInputsOf(state: AppState): GapInputs | null {
  const document = state.assembly;
  const view = state.assemblyView;
  const selected = state.selection.filter((id) => document?.components.some((component) => component.id === id) === true);
  const [first, second] = selected;
  if (document === null || view === null || view.sourceDocument !== document || selected.length !== 2
    || first === undefined || second === undefined || first === second) return null;
  const placements = state.assemblyMotionPlacements !== null && state.assemblyMotionSourceDocument === document
    ? state.assemblyMotionPlacements : view.resolved.placements;
  return { document, sourceDocument: view.sourceDocument, resolved: view.resolved, bodies: view.bodies, placements,
    motionPlacements: state.assemblyMotionPlacements, motionSourceDocument: state.assemblyMotionSourceDocument,
    pair: [first, second], unit: state.displaySettings.lengthUnit };
}

function sameGapInputs(left: GapInputs | null, right: GapInputs | null): boolean {
  if (left === null || right === null) return left === right;
  return left.document === right.document && left.sourceDocument === right.sourceDocument && left.resolved === right.resolved
    && left.bodies === right.bodies && left.placements === right.placements && left.motionPlacements === right.motionPlacements
    && left.motionSourceDocument === right.motionSourceDocument && left.pair[0] === right.pair[0] && left.pair[1] === right.pair[1]
    && left.unit === right.unit;
}

function interferenceInputOf(inputs: GapInputs, requestId: string): AssemblyInterferenceInput {
  return { requestId, components: [...inputs.document.components], resolved: inputs.resolved, bodies: new Map(inputs.bodies),
    placements: new Map(inputs.placements) };
}

export function attachAssemblyInterference(bridge: Pick<InterferenceKernelBridge, 'measure' | 'checkInterference'>): () => void {
  const runner = createAssemblyInterferenceRunner(bridge);
  let detached = false;
  /** 今ほしい測る中身(最新の 1 件)。測っている間に変わったら、今の測定が終わってから流す。 */
  let wanted: GapInputs | null = null;
  /** 流している測定(同時に 1 本まで)。上限を超えても、返事が来るまでは流している扱い。 */
  let inFlight: { readonly inputs: GapInputs; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  let lastGap: MeasurementState | null = null;
  useAppStore.getState().setAssemblyInterferenceRunner(runner);

  function clearGap(state: AppState): void {
    if (lastGap !== null && state.measurement === lastGap) {
      useAppStore.setState({ measurement: null, massProperties: null });
    }
    lastGap = null;
  }

  function start(inputs: GapInputs): void {
    const requestId = crypto.randomUUID();
    useAppStore.setState({ assemblyGapRequestId: requestId });
    const owns = (): boolean => !detached && wanted === inputs && useAppStore.getState().assemblyGapRequestId === requestId;
    const timer = setTimeout(() => {
      // 待つのをやめる(古い結果は出さない)。選び直すか形が変わると、今の測定が終わってから測り直す。
      if (owns()) useAppStore.setState({ assemblyGapRequestId: null, measureErrorKey: 'measureError.gapTimeout' });
    }, GAP_MEASURE_TIMEOUT_MS);
    inFlight = { inputs, timer };
    void runner.measureGap(interferenceInputOf(inputs, requestId), inputs.pair[0], inputs.pair[1], inputs.unit)
      .then((measurement) => {
        if (!owns()) return;
        lastGap = measurement;
        useAppStore.setState({ assemblyGapRequestId: null, measurement, massProperties: null,
          measureErrorKey: measurement === null ? MEASURE_FAILED_MESSAGE_KEY : null });
      }, () => {
        if (owns()) useAppStore.setState({ assemblyGapRequestId: null, measureErrorKey: MEASURE_FAILED_MESSAGE_KEY });
      })
      .finally(() => {
        clearTimeout(timer);
        inFlight = null;
        if (!detached && wanted !== null && wanted !== inputs) start(wanted);
      });
  }

  function sync(state: AppState): void {
    const inputs = gapInputsOf(state);
    if (sameGapInputs(inputs, wanted)) return;
    wanted = inputs;
    clearGap(state);
    if (inputs === null) {
      if (state.assemblyGapRequestId !== null) useAppStore.setState({ assemblyGapRequestId: null });
      return;
    }
    if (inFlight === null) start(inputs);
    else if (state.assemblyGapRequestId !== null) useAppStore.setState({ assemblyGapRequestId: null });
  }

  sync(useAppStore.getState());
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.assembly !== previous.assembly || next.assemblyView !== previous.assemblyView
      || next.selection !== previous.selection
      || next.assemblyMotionPlacements !== previous.assemblyMotionPlacements
      || next.assemblyMotionSourceDocument !== previous.assemblyMotionSourceDocument
      || next.displaySettings.lengthUnit !== previous.displaySettings.lengthUnit) sync(next);
  });

  return () => {
    detached = true;
    unsubscribe();
    if (inFlight !== null) clearTimeout(inFlight.timer);
    const state = useAppStore.getState();
    clearGap(state);
    if (state.assemblyInterferenceRunner === runner) state.setAssemblyInterferenceRunner(null);
  };
}
