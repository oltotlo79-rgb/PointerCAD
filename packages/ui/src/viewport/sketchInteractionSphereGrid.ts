/**
 * 球面上の点の道具(FR-431)の、ビューポートでの吸着と確定の責務。
 *
 * 選んでいる球の案内線の交点へポインタを吸い付け、開いている欄へ緯度・経度を入れ、押した交点に
 * 点を 1 つ作る。作る中身は緯度・経度を打つ経路(`solidCommands.ts`)と同じ `commitSphereGridPoint`
 * なので、どちらから作っても文書はまったく同じ形になる(NFR-UX-1)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { FREE_WORK_PLANE_ID } from '@pointercad/model';

import { reduceNumericInput } from '../sketch/numericInput.js';
import { commitSphereGridPoint, selectedSphereFeature, sphereGridSphereOf } from '../sketch/sketchCommands.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import { useAppStore } from '../store/useAppStore.js';
import { snapToSphereGrid, type SphereGridPoint, type SphereGridSpec } from './buildSphereGrid.js';
import type { ViewportScene } from './createViewportScene.js';

type Pointer = readonly [number, number];

interface SketchSphereGridContext {
  readonly scene: ViewportScene;
  readonly project: ProjectToScreen;
}

/**
 * いま吸着の相手にする球と間隔(FR-431)。相手がいなければ null。
 *
 * 相手は**選んでいる球だけ**にする(「いつも出す」で見えているだけの球は相手にしない。
 * どの球の上に点を置くかは利用者が選んだもので決める、`sphereGridTargetSphere` の注釈)。
 * 吸着そのものが切(FR-107)のときも相手にしない。
 */
function sphereGridTarget(): { readonly spec: SphereGridSpec; readonly sphereFeatureId: string } | null {
  const state = useAppStore.getState();
  if (state.activeTool !== 'sphereGridPoint' || !state.snapEnabled) {
    return null;
  }
  const feature = selectedSphereFeature(state.document, state.selection);
  if (feature === null) {
    return null;
  }
  const sphere = sphereGridSphereOf(feature, state.resolvedSketch);
  if (sphere === null) {
    return null;
  }
  return {
    sphereFeatureId: sphere.featureId,
    spec: {
      center: sphere.center,
      radius: sphere.radius,
      stepDegrees: state.sphereGridStep.value,
    },
  };
}

/** 1 つの canvas の球面上の点の入力。返す関数はどれも呼ばれた時点のストアを読む。 */
export function createSketchSphereGridInput(context: SketchSphereGridContext) {
  const { scene, project } = context;

  /**
   * ポインタの下にある案内線の交点(FR-431)。無ければ null。
   *
   * **候補を全部回さない。** 光線と球の交点を解いて緯度・経度へ直し、間隔で丸めるだけなので、
   * 費用は交点の数(5° で 2,522 個)に依らず一定になる(`buildSphereGrid.ts` の
   * `nearestSphereGridPoint`)。スケッチの当たり判定(`pickMath.ts`)のように候補を毎回
   * 画面へ写していたら `pointermove` ごとに 2,522 回の変換になり、NFR-PF-1 を割る。
   * 画面座標で 12 画素まで、の判定だけは `snapToSphereGrid` が 1 点ぶん行う。
   */
  function sphereGridPointAtPointer(
    pointer: Pointer,
  ): { readonly point: SphereGridPoint; readonly sphereFeatureId: string } | null {
    const target = sphereGridTarget();
    if (target === null) {
      return null;
    }
    const ray = scene.pointerRay(pointer[0], pointer[1]);
    if (ray === null) {
      return null;
    }
    const point = snapToSphereGrid(target.spec, ray, project, pointer);
    return point === null ? null : { point, sphereFeatureId: target.sphereFeatureId };
  }

  /**
   * 案内線の交点に吸い付いた緯度・経度を、開いている段の欄へ入れる。
   *
   * **値が変わったときだけ**ストアへ書く。ポインタが同じ升の中を滑っている間は丸めた
   * 緯度・経度が変わらないので、`pointermove` のたびに書き直すことはない(NFR-PF-1)。
   */
  function updateSphereGridInput(pointer: Pointer): void {
    const state = useAppStore.getState();
    const opened = state.numericInput;
    if (opened === null || opened.toolId !== 'sphereGridPoint') {
      return;
    }
    const found = sphereGridPointAtPointer(pointer);
    if (found === null) {
      return;
    }
    const latitude = expressionValueFromNumber(found.point.latitude).source;
    const longitude = expressionValueFromNumber(found.point.longitude).source;
    if (opened.fields[0]?.source === latitude && opened.fields[1]?.source === longitude) {
      return;
    }
    state.updateNumericInput(
      reduceNumericInput(opened, {
        type: 'setValues',
        values: [found.point.latitude, found.point.longitude],
      }),
    );
  }

  /**
   * 案内線の交点を押して球面上の点を 1 つ作る(FR-431)。作れたら true。
   *
   * 交点に吸い付いていないときは false を返し、呼び出し側はふつうの選択(球を選び直す)へ
   * 落とす。**押した瞬間に決まる**(立体の頂点を押して点を作るのと同じ)ので、道具も選択も
   * そのまま残り、続けて何点でも取れる。
   */
  function commitSphereGridClick(pointer: Pointer): boolean {
    const found = sphereGridPointAtPointer(pointer);
    if (found === null) {
      return false;
    }
    const state = useAppStore.getState();
    state.setSolidError(null);
    state.setSketch(
      commitSphereGridPoint(
        state.sketch,
        // 球面上の点は 3D スケッチの点(FR-330)。作図面の上には乗らない。
        FREE_WORK_PLANE_ID,
        found.sphereFeatureId,
        expressionValueFromNumber(found.point.latitude),
        expressionValueFromNumber(found.point.longitude),
      ),
    );
    return true;
  }

  return { updateSphereGridInput, commitSphereGridClick };
}
