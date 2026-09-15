import type { WorkPlaneId } from '@pointercad/model';
import type { NumericInputToolId } from '../../sketch/numericInput.js';
import { freeSketchToolRejection } from '../../sketch/freeSketch.js';
import { useAppStore } from '../../store/useAppStore.js';
export { TOOLS, PLANES, PLANE_TOOLS, REFERENCE_TOOLS, SNAP_KINDS_UI, INITIAL_STEPS } from './sketchToolDescriptors.js';

/** 角度の札(「15°」)。言葉に依らない書き方なのでここで組み立てる(SettingsPanel と同じ流儀)。 */
const DEGREE_SIGN = '°';

export function angleStepLabel(step: number): string {
  return `${String(step)}${DEGREE_SIGN}`;
}

/** 角度の刻みを差し替える(テーマと拡大率はそのまま)。 */
export function selectTrackAngleStep(step: number): void {
  const store = useAppStore.getState();
  store.setDisplaySettings({ ...store.displaySettings, trackAngleStep: step });
}

/**
 * 3D スケッチ(FR-330)で使えない道具は選ばせず、理由を帯へ出す(NFR-UX-5、タスク14)。
 *
 * 使える・使えないの判断は `freeSketch.ts` の `freeSketchToolRejection` 1 か所に置いてある。
 * 押せなくするのではなく「押したら理由が出る」形にしてあるのは、押せない見た目だけだと
 * なぜ使えないのかが分からないため(P3 の加工6種と同じ扱い、`docs/報告記録.md`
 * 2026-09-04 10:50 の仕上げ (e)-(b))。
 */
export function blockedInFreeSketch(tool: NumericInputToolId): boolean {
  const store = useAppStore.getState();
  const rejection = freeSketchToolRejection(store.workPlaneId, tool);
  if (rejection === null) {
    return false;
  }
  store.setShapeError(rejection);
  return true;
}

/**
 * 作図面を選び直す(FR-328、FR-330)。3D スケッチへ切り替えたときに、作図面が要る道具を
 * 選んだままにしない(その道具のまま押すと理由も出せずに何も起きないため)。
 */
export function selectWorkPlane(planeId: WorkPlaneId): void {
  const store = useAppStore.getState();
  store.setWorkPlane(planeId);
  const rejection = freeSketchToolRejection(planeId, store.activeTool);
  if (rejection !== null) {
    store.setActiveTool('select');
    store.setShapeError(rejection);
  }
}
