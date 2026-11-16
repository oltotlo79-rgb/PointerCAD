/**
 * 押し出しの領域(M-01 の M01-3)の当たり判定の責務。
 *
 * 押し出しの道具で面を選んでいない間だけ、カーソルの下の閉じた領域を返し(ホバーで濃くする)、押した領域を押し出しの
 * 欄へ入れる(結果と相手の提案も入る、M01-4)。押せば選べる領域と、乗せて濃くなる領域は同じこの道を通るので、
 * 「押せば選べるのに色は出ない」という食い違いは起きない(`sketchInteractionSolidPicking.ts` と同じ考え)。
 *
 * - 作図面は領域ごとに違ってよい。押した画素からの視線と各作図面の交点のうち、いちばん手前の領域を選ぶ
 *   (`solid/regionPick.ts`)。
 * - スケッチの要素(面・線・点)を押した時は扱わず、今までどおりの選択に任せる(面を選べば面で押し出す)。
 * - 文書は変えない(欄の中身だけ)。断る時は理由を帯に出す。
 */
import { pickSketchElement, sketchForSelection } from '../sketch/pickMath.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import { cancelExtrusion } from '../solid/extrudePreview.js';
import { activeExtrudeRegions, clickExtrudeRegion, regionHoverIdAt } from '../solid/regionPick.js';
import { useAppStore } from '../store/useAppStore.js';
import type { ViewportScene } from './createViewportScene.js';

type Pointer = readonly [number, number];

interface SketchRegionInputContext {
  readonly scene: Pick<ViewportScene, 'pointerRay'>;
  readonly project: ProjectToScreen;
}

/** 1 つの canvas の領域の当たり判定。返す関数はどれも呼ばれた時点のストアを読む。 */
export function createSketchRegionInput(context: SketchRegionInputContext) {
  const { scene, project } = context;

  /** カーソルの下の、塗って押せる領域の id。押し出しが領域を選ぶ状態でなければ null。 */
  function regionHoverAt(pointer: Pointer): string | null {
    const active = activeExtrudeRegions(useAppStore.getState());
    if (active === null || active.regions.length === 0) return null;
    const ray = scene.pointerRay(pointer[0], pointer[1]);
    return ray === null ? null : regionHoverIdAt(active, ray);
  }

  /**
   * 押した所の領域を押し出しの欄へ入れる。扱ったら true(選べた時も、理由を出して断った時も)。
   * 領域を選ぶ状態でない時・スケッチの要素を押した時は false を返し、今までどおりの選択に任せる。
   */
  function commitRegionClick(pointer: Pointer): boolean {
    const state = useAppStore.getState();
    if (activeExtrudeRegions(state) === null) return false;
    const filtered = sketchForSelection(state.resolvedSketch, state.displaySettings.selectionFilter);
    if (pickSketchElement(filtered, project, pointer) !== null) return false;
    const ray = scene.pointerRay(pointer[0], pointer[1]);
    const outcome = ray === null ? null : clickExtrudeRegion(state, ray);
    if (outcome === null) return false;
    if (outcome.kind === 'refused') {
      state.setSolidError(outcome.reasonKey);
      return true;
    }
    // 前の領域で確かめた形は、選び直した領域の形ではないので捨てる(新しい入力の窓と同じ扱い)。
    cancelExtrusion();
    state.setSolidError(null);
    state.updateNumericInput(outcome.input);
    return true;
  }

  return { regionHoverAt, commitRegionClick };
}
