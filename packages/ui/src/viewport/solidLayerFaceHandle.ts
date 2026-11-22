/**
 * 面の移動の矢印のつまみ(M-05 4-2a)を立体の層に描く。
 *
 * 描くのは矢印 1 本(軸と先の羽 2 本の線分)だけ。根もとは欄の距離だけ動かした所、向きは面の外向きの法線
 * (位置と向きを決めるのは `../solid/faceOffsetHandle.ts`)。形は切断の予告・断面のつまみの矢印と同じ
 * (`buildCutPreview.ts`)、長さの決め方も断面のつまみと同じ(`solidLayerHelpers.ts` の `handleDiagonal`)。
 * 色はテーマの表の吸着の案内の色(`track`。5 テーマとも地に対して 3:1 以上)。
 *
 * 部品は初めて出す時に作る(入力欄を開かない間は層の部品の並びを 1 つも変えない)。一度作った部品は、
 * 消す時も捨てずに隠し、層の破棄(`createSolidLayer.ts` の `registerSolidLayerCleanup`)で形と材質を返す。
 * 同じつまみ(同一参照)を渡し直したときは並びを触らない(NFR-PF-1。描画のたびに渡されるため)。
 * 引いている途中も文書は変えない(欄の数だけが変わり、その値からつまみが作り直される)。
 */
import { crossVec3, normalizeVec3, type ResolvedPlane, type Vec3 } from '@pointercad/model';
import * as THREE from 'three';

import type { FaceOffsetHandle } from '../solid/faceOffsetHandle.js';
import { buildCutPreviewPositions } from './buildCutPreview.js';
import type { BodyDraw } from './solidLayerBodies.js';
import { setVectorAttribute } from './solidLayerBuffers.js';
import { handleDiagonal, referenceAxis } from './solidLayerHelpers.js';
import { SUB_SHAPE_LINE_RENDER_ORDER } from './solidLayerRenderOrder.js';
import type { ThemeColors } from './themeColors.js';

/** 層が描くつまみ(`FaceOffsetHandle` のうち、描くのに要る根もと `origin` と外向きの単位法線 `normal` の 2 つ)。 */
export type FaceOffsetArrow = Pick<FaceOffsetHandle, 'origin' | 'normal'>;

type ArrowLines = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

interface FaceHandleOptions {
  readonly group: THREE.Group;
  /** いま描いているボディ。矢印の長さを測る。 */
  readonly draws: readonly BodyDraw[];
  /** いま効いているテーマの色(作る時の色に使う)。 */
  readonly getColors: () => ThemeColors;
}

/**
 * 矢印を、根もとを原点にした局所の座標で組み立てる平面(羽は axisU の向きに張る)。
 * 根もと(double)は部品の位置で置くので、遠いつまみでも大きさが Float32 で崩れない(断面のつまみと同じ)。
 */
function arrowPlane(normal: Vec3): ResolvedPlane {
  const axisU = normalizeVec3(crossVec3(referenceAxis(normal), normal));
  return { origin: [0, 0, 0], normal, axisU, axisV: crossVec3(normal, axisU) };
}

/** 1 つの層の面の移動のつまみ。返す関数はどれも層の持ち主(`createSolidLayer`)だけが呼ぶ。 */
export function createSolidFaceHandleDisplay(options: FaceHandleOptions) {
  const { group, draws, getColors } = options;
  let arrow: ArrowLines | null = null;
  let lastHandle: FaceOffsetArrow | null = null;

  /** 初めて出す時だけ作る。`depthTest` を切って、面や立体に隠れても掴める所が見えるようにする。 */
  function ensureArrow(): ArrowLines {
    if (arrow !== null) return arrow;
    const created: ArrowLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: getColors().track, transparent: true, depthTest: false, depthWrite: false,
    }));
    created.renderOrder = SUB_SHAPE_LINE_RENDER_ORDER;
    created.visible = false;
    group.add(created);
    arrow = created;
    return created;
  }

  /** 矢印を組み立て直す。つまみが無ければ隠すだけ(作っていなければ何もしない)。 */
  function rebuild(): void {
    if (lastHandle === null) {
      if (arrow !== null) arrow.visible = false;
      return;
    }
    const lines = ensureArrow();
    const positions = buildCutPreviewPositions(arrowPlane(lastHandle.normal), handleDiagonal(draws, lastHandle.origin),
      'positive').arrowPositions;
    lines.position.set(lastHandle.origin[0], lastHandle.origin[1], lastHandle.origin[2]);
    lines.updateMatrixWorld(true);
    setVectorAttribute(lines.geometry, 'position', positions);
    lines.geometry.computeBoundingSphere();
    lines.visible = positions.length > 0;
  }

  return {
    update(handle: FaceOffsetArrow | null): void {
      if (handle === lastHandle) return;
      lastHandle = handle;
      rebuild();
    },
    /** 形が変われば矢印の長さも変わるので、出しているあいだは組み立て直す。 */
    rebuild,
    applyTheme(colors: ThemeColors): void {
      arrow?.material.color.setHex(colors.track);
    },
    /** 破棄で解放する部品(作っていなければ空)。 */
    ownedObjects(): readonly ArrowLines[] {
      return arrow === null ? [] : [arrow];
    },
    /** 破棄の終わりに、控えを空にする。 */
    reset(): void {
      arrow = null;
      lastHandle = null;
    },
  };
}
