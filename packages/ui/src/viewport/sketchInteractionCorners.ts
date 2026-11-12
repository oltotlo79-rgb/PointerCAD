/**
 * 角の丸め・面取りの道具(FR-323)の、ビューポートでの予告と押下の責務。
 *
 * 乗せた角に丸めた形・面取りした形を薄く予告し(NFR-UX-5)、押した角の 2 本を選択に入れて
 * 半径・距離を聞く欄をその場に開く(NFR-UX-2)。**確定が読むのは選択の 2 本**なので、
 * 「2 本を選んでから道具を押す」道(`Toolbar.tsx`)と 1 本の経路に合流する(NFR-UX-1)。
 */
import { isFreeWorkPlaneId, lengthVec3, subVec3, type Vec3, type WorkPlane } from '@pointercad/model';

import { createConfiguredNumericInput as createNumericInput } from '../settings/createConfiguredNumericInput.js';
import { cornerNear, cornerPreview, type CornerHit, type CornerShape } from '../sketch/cornerCommands.js';
import {
  DEFAULT_SKETCH_CHAMFER_DISTANCE_MM,
  DEFAULT_SKETCH_FILLET_RADIUS_MM,
  EDIT_TOOL_STEPS,
  type CornerEditToolId,
} from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import type { ViewportScene } from './createViewportScene.js';
import type { SketchInteractionIndicators } from './sketchInteractionIndicators.js';

type Pointer = readonly [number, number];

/**
 * 角を拾う輪の大きさ(画素)。当たり判定(6 画素)や吸着(12 画素)より広くしてある。
 * 狙っているのは線そのものではなく「2 本が交わる 1 点」で、細い線と違って多少ずれても
 * 迷う相手がいないため(近い角が 2 つあるときは近いほうを採る、`cornerNear`)。
 */
const CORNER_PICK_RADIUS_PIXELS = 20;

interface SketchCornerContext {
  readonly scene: ViewportScene;
  readonly indicators: SketchInteractionIndicators;
  /** 操作に使う作図面(`sketchInteractionCoordinates.ts`)。 */
  readonly interactionPlane: (planeId: string) => WorkPlane;
}

/** 予告に使う作図面。3D スケッチ(FR-330)は角そのものから面を作るので null を渡す。 */
function cornerPlane(): WorkPlane | null {
  const state = useAppStore.getState();
  return isFreeWorkPlaneId(state.workPlaneId) ? null : state.workPlane;
}

/** まだ欄を開いていない予告の形。既定値で丸めた・面取りした形を出す(NFR-UX-4)。 */
function cornerShapeOf(tool: CornerEditToolId): CornerShape {
  return tool === 'sketchFillet'
    ? { kind: 'fillet', radius: DEFAULT_SKETCH_FILLET_RADIUS_MM }
    : {
        kind: 'chamfer',
        distance1: DEFAULT_SKETCH_CHAMFER_DISTANCE_MM,
        distance2: DEFAULT_SKETCH_CHAMFER_DISTANCE_MM,
      };
}

/** 1 つの canvas の角の道具。返す関数はどれも呼ばれた時点のストアを読む。 */
export function createSketchCornerTools(context: SketchCornerContext) {
  const { scene, indicators, interactionPlane } = context;

  /**
   * 画素で決めた輪を、世界の長さ(mm)へ直す。拡大率を変えても「画面上で同じ広さ」に
   * 見えるようにするため(近い/遠いで拾いやすさが変わらない)。
   * 作図面の上で真横へ `CORNER_PICK_RADIUS_PIXELS` だけ動いた点との距離で測る。
   */
  function cornerRadiusInWorld(pointer: Pointer, plane: WorkPlane, at: Vec3): number {
    const offset = scene.screenToPlanePoint(
      pointer[0] + CORNER_PICK_RADIUS_PIXELS,
      pointer[1],
      plane,
    );
    return offset === null ? CORNER_PICK_RADIUS_PIXELS : lengthVec3(subVec3(offset, at));
  }

  /** 角の丸め・面取りで、いま指している角。指していなければ null。 */
  function cornerTargetAt(pointer: Pointer): CornerHit | null {
    const state = useAppStore.getState();
    const plane = interactionPlane(state.workPlaneId);
    const at = scene.screenToPlanePoint(pointer[0], pointer[1], plane);
    if (at === null) {
      return null;
    }
    return cornerNear(
      state.sketch,
      state.resolvedSketch,
      at,
      cornerRadiusInWorld(pointer, plane, at),
    );
  }

  /**
   * 角の丸め・面取りのときのマウスの動き(FR-323、NFR-UX-5)。乗せた角に、丸めた形/
   * 面取りした形を薄く予告する。角に乗っていなければ何も強調しない。
   */
  function updateCornerPreview(tool: CornerEditToolId, pointer: Pointer): void {
    const state = useAppStore.getState();
    const hit = cornerTargetAt(pointer);
    // 角を作っている 1 本目を強調して、どの角を指しているかを分かりやすくする。
    const nextHovered = hit === null ? null : hit.firstElementId;
    if (nextHovered !== state.hoveredElementId) {
      state.setHovered(nextHovered);
    }
    indicators.clearSnapIndicators();
    indicators.showEdit(hit === null ? null : cornerPreview(hit, cornerPlane(), cornerShapeOf(tool)));
  }

  /** 角の丸め・面取りのクリック(FR-323)。指した角の 2 本を選び、半径/距離の欄をその場に開く。 */
  function openCornerInput(tool: CornerEditToolId, pointer: Pointer): void {
    const state = useAppStore.getState();
    const hit = cornerTargetAt(pointer);
    if (hit === null) {
      state.setEditError('corner.error.noCornerHere');
      return;
    }
    state.setSelection([hit.firstElementId, hit.secondElementId]);
    state.setPickAnchor(pointer);
    state.openNumericInput(createNumericInput(tool, EDIT_TOOL_STEPS[tool]), pointer);
  }

  return { updateCornerPreview, openCornerInput };
}
