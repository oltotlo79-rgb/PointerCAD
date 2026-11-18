import { applyPlacementToPoint, type RigidPlacement, type Vec3, type WorkPlane } from '@pointercad/model';

import { frameStrokeLevelPlane, type FrameStrokeHit } from '../assembly/frameStroke.js';
import type { FrameUp } from '../assembly/frameLayoutInput.js';
import { SUB_SHAPE_PICK_RADIUS_PIXELS } from '../solid/pickSubShape.js';
import { subShapeFrameOrigin, type SubShapeBody } from '../solid/subShapeSelection.js';

/**
 * 一筆書きの配置(E-08)の 3D の画面の押下を、点の列へ足す当たりにする。見えている部品の頂点が画面で近ければ(部分形状の当たりと
 * 同じ 6px)その頂点のワールドの点、無ければ前の点の高さの面(`frameStrokeLevelPlane`)と視線の交点。どちらも無ければ null。
 * 頂点は画面の近さだけで拾う(部分形状の当たりと同じく深度は見ない)。
 */

/** 頂点を探す部品の並び(アセンブリの文書と表示から渡す)。 */
interface FrameStrokePickSource {
  readonly components: readonly { readonly id: string; readonly suppressed: boolean; readonly visible: boolean }[];
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  readonly partKeys: ReadonlyMap<string, string>;
  readonly bodies: ReadonlyMap<string, readonly SubShapeBody[]>;
}

/** 画面の写し方と、作図面の上の点の求め方(3D の画面の scene の口)。 */
interface FrameStrokePickScene {
  worldToScreen(point: Vec3): readonly [number, number] | null;
  screenToPlanePoint?(x: number, y: number, plane: WorkPlane): Vec3 | null;
}

/** 画面で一番近い頂点のワールドの点(当たりの半径の外なら null)。 */
function nearestVertex(source: FrameStrokePickSource, scene: FrameStrokePickScene, pointer: readonly [number, number]): Vec3 | null {
  let best: { readonly point: Vec3; readonly distance: number } | null = null;
  for (const component of source.components) {
    if (component.suppressed || !component.visible) continue;
    const placement = source.placements.get(component.id);
    const partKey = source.partKeys.get(component.id);
    const bodies = partKey === undefined ? undefined : source.bodies.get(partKey);
    if (placement === undefined || bodies === undefined) continue;
    for (const body of bodies) {
      if (subShapeFrameOrigin(body) === null) continue;
      for (const vertex of body.vertices) {
        const point = applyPlacementToPoint(placement, vertex.position);
        const screen = scene.worldToScreen(point);
        if (screen === null) continue;
        const distance = Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]);
        if (distance <= SUB_SHAPE_PICK_RADIUS_PIXELS && (best === null || distance < best.distance)) best = { point, distance };
      }
    }
  }
  return best?.point ?? null;
}

/** 押した所の当たり(頂点か、前の点の高さの面の上の点)。 */
export function frameStrokeHitAt(source: FrameStrokePickSource, scene: FrameStrokePickScene, pointer: readonly [number, number],
  stroke: { readonly points: readonly Vec3[]; readonly closed: boolean; readonly up: FrameUp }): FrameStrokeHit | null {
  const vertex = nearestVertex(source, scene, pointer);
  if (vertex !== null) return { kind: 'vertex', point: vertex };
  const point = scene.screenToPlanePoint?.(pointer[0], pointer[1], frameStrokeLevelPlane(stroke, stroke.up)) ?? null;
  return point === null ? null : { kind: 'level', point };
}
