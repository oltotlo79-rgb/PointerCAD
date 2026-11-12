/**
 * スケッチの操作の中で立体を拾う責務(FR-106、FR-112、FR-330)。
 *
 * 押した場所・乗せた場所にある立体、部分形状(面・辺・頂点)、3D スケッチで座標の入り口になる
 * 立体の頂点を返す。**押して選ぶのも、乗せて強調するのも同じこの道を通る**ので、「押せば
 * 選べるのに色は出ない」という食い違いは起きない。どれも選択フィルタ(FR-112)を通し、
 * ストアは読むだけで変えない。
 */
import type { SubShapeRef } from '@pointercad/model';

import { picksSolidVertices } from '../sketch/freeSketch.js';
import type { NumericInputToolId } from '../sketch/numericInput.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import { pickSolidSubShape } from '../solid/pickSubShape.js';
import { filterPickCandidates, type SelectionFilter } from '../solid/selectionFilter.js';
import { subShapeElementId, subShapeRefOf, type SelectionKind, type SubShapeBody } from '../solid/subShapeSelection.js';
import { useAppStore } from '../store/useAppStore.js';
import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import type { ViewportScene } from './createViewportScene.js';
import { stagedPreviewOf } from './solidMeshAdmission.js';

type Pointer = readonly [number, number];

interface SketchSolidPickingContext {
  readonly scene: ViewportScene;
  readonly project: ProjectToScreen;
  /** 立体そのものをクリックで選べる道具か(`attachSketchInteraction.ts` の `picksBodies`)。 */
  readonly picksBodies: (tool: NumericInputToolId) => boolean;
  /** 部分形状を拾う種類と道具か(`attachSketchInteraction.ts` の `picksSubShapes`)。 */
  readonly picksSubShapes: (kind: SelectionKind, tool: NumericInputToolId) => boolean;
  readonly toSubShapeBodies: (bodies: readonly SolidBodyWithSubShapes[]) => readonly SubShapeBody[];
}

/**
 * 拾った 1 件を選択フィルタ(FR-112)に通す。切ってある種類なら null。
 * 絞り込みそのものは Node で検査できる純関数(`solid/selectionFilter.ts` の `filterPickCandidates`)。
 *
 * **限界**: 選択の種類が `edge` のときは頂点が辺に勝つので、頂点だけを切ってあると
 * 「頂点の上に乗った瞬間だけ辺も拾えない」。頂点を外して辺を拾い直すには
 * `pickSolidSubShape` に辺だけの道が要る。
 */
function throughSelectionFilter(
  picked: { readonly elementId: string; readonly kind: SelectionKind } | null,
  filter: SelectionFilter,
): string | null {
  if (picked === null) {
    return null;
  }
  const [kept] = filterPickCandidates([picked], filter);
  return kept === undefined ? null : kept.elementId;
}

/** 1 つの canvas の立体の当たり判定。返す関数はどれも呼ばれた時点のストアを読む。 */
export function createSketchSolidPicking(context: SketchSolidPickingContext) {
  const { scene, project, picksBodies, picksSubShapes, toSubShapeBodies } = context;

  /**
   * 押した場所にある立体の id(FR-106)。立体が 1 つも無いときは光線を飛ばさない。
   * スケッチの要素のほうが細くて狙いにくいので、**必ず要素を先に**当ててから呼ぶ
   * (小さいものを先に取る)。
   *
   * 選択フィルタ(FR-112)で「立体」を切ってあるときは光線そのものを飛ばさない。
   */
  function pickBodyAt(pointer: Pointer): string | null {
    const state = useAppStore.getState();
    if (
      state.bodies.length === 0 ||
      !picksBodies(state.activeTool) ||
      !state.displaySettings.selectionFilter.body
    ) {
      return null;
    }
    return scene.pickBody(pointer[0], pointer[1]);
  }

  /**
   * 押した場所にある立体の部分形状(面・辺・頂点)の要素 id。選択の種類が `body` の
   * ときや、部分形状を拾わない道具(かき込む道具)のときは呼ばない前提で null を返す。
   *
   * 面は光線(`pickFaceAt`)、辺・頂点は画面座標(`pickSolidSubShape`。頂点が辺に勝つ、
   * 裏側も含む)。**吸着(スケッチの点への吸い付き)はここでは使わない**
   * (吸着は作図の補助で、既にある立体の部分形状を拾う場面とは関係が薄い)。
   */
  function pickSubShapeAt(pointer: Pointer): string | null {
    const state = useAppStore.getState();
    const { selectionKind, bodies, activeTool } = state;
    if (selectionKind === 'body' || bodies.length === 0 || !picksSubShapes(selectionKind, activeTool)) {
      return null;
    }
    // 押し出しの仮の形を描いている間は、画面に見えていない確定済みの辺・頂点を拾わない
    // (面は描いている層を当てるので、場面の側が仮の形を当てないようにしてある)。
    if (stagedPreviewOf(state) !== null) {
      return null;
    }
    const filter = state.displaySettings.selectionFilter;
    if (selectionKind === 'face') {
      // 面を切ってあるときは光線そのものを飛ばさない(FR-112)。
      if (!filter.face) {
        return null;
      }
      const hit = scene.pickFaceAt(pointer[0], pointer[1]);
      return hit === null ? null : subShapeElementId(hit.featureId, 'face', hit.faceIndex);
    }
    // ここまで来たら edge か vertex(pickSolidSubShape が要る SubShapeKind、頂点 > 辺の順)。
    const picked = pickSolidSubShape(toSubShapeBodies(bodies), project, pointer, selectionKind);
    return throughSelectionFilter(picked, filter);
  }

  /**
   * 3D スケッチ(FR-330)で、押した場所にある立体の頂点。
   *
   * 作図面のあるスケッチでは、かき込む道具は立体も部分形状も拾わない(押した場所が座標
   * そのものになる道具なので、当たり判定を挟むと座標の入り口が曖昧になる)。3D スケッチだけは
   * **立体の頂点を押すことが座標の入り口そのもの**なので、点・線分・円弧・スプラインの
   * 道具のときに限って頂点を拾う(`picksSolidVertices`)。辺・面は拾わない(点にできるのは
   * 頂点だけ。辺の中点・面の中心を点にするのは基準点の道具の役目、FR-329)。
   */
  function pickFreeVertexAt(pointer: Pointer): string | null {
    const state = useAppStore.getState();
    if (!picksSolidVertices(state.workPlaneId, state.activeTool) || state.bodies.length === 0
      || stagedPreviewOf(state) !== null) {
      return null;
    }
    // 選択フィルタ(FR-112)で頂点を切ってあるときは、3D スケッチでも頂点を拾わない。
    const picked = pickSolidSubShape(toSubShapeBodies(state.bodies), project, pointer, 'vertex');
    return throughSelectionFilter(picked, state.displaySettings.selectionFilter);
  }

  /** 押した頂点から、文書へ保存する参照(選んだ瞬間の指紋つき)を作る。 */
  function freeVertexRefAt(pointer: Pointer): SubShapeRef | null {
    const elementId = pickFreeVertexAt(pointer);
    if (elementId === null) {
      return null;
    }
    return subShapeRefOf(toSubShapeBodies(useAppStore.getState().bodies), elementId);
  }

  return { pickBodyAt, pickSubShapeAt, pickFreeVertexAt, freeVertexRefAt };
}
