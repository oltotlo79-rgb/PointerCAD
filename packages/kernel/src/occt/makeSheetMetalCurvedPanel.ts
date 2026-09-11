/** 曲げ帯を横断する穴や傾いた外周も、円筒面上の輪郭として厚み付けする。 */
import type { Handle_Geom_Surface, OpenCascadeInstance, TopoDS_Wire } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { cylinderProfileCurves } from './cylinderProfileCurves.js';
import { curveC1Continuity } from './curveContinuity.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';
import { validateSheetMetalBendFrame, type SheetMetalBendFrame } from './makeSheetMetalBend.js';
import { boundingBoxOf, boundingBoxRange } from './placeBodies.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { tryRectilinearBend } from './rectilinearBend.js';

export interface SheetMetalCurvedPanelInput {
  readonly frame: SheetMetalBendFrame;
  readonly radius: number; readonly thickness: number; readonly neutralRadius: number;
  readonly angle: number;
  /** 接線をy=0とした展開面(x=幅,y=中立長,z=0)。外周CCW、穴CW。 */
  readonly outer: readonly CurveSpec[]; readonly holes: readonly (readonly CurveSpec[])[];
}

function curvedWire(oc: OpenCascadeInstance, curves: readonly CurveSpec[], surface: Handle_Geom_Surface,
  radius: number, direction: -1 | 1, keep: Allocations['keep']): TopoDS_Wire {
  const maker = keep(new oc.BRepBuilderAPI_MakeWire_1());
  const continuity = curveC1Continuity(oc);
  for (const curve of curves) for (const uv of cylinderProfileCurves(oc, curve, radius, direction, keep)) {
    const edgeMaker = keep(uv.bounds === undefined ? new oc.BRepBuilderAPI_MakeEdge_30(uv.curve, surface)
      : new oc.BRepBuilderAPI_MakeEdge_31(uv.curve, surface, uv.bounds[0], uv.bounds[1]));
    if (!edgeMaker.IsDone()) throw new Error('曲げ部分の境界を円筒面に作れませんでした。');
    const edge = keep(edgeMaker.Edge());
    if (!oc.BRepLib.BuildCurves3d_1(edge, 1e-9, continuity, 14, 0)) throw new Error('曲げ部分の境界を立体へ結び付けられませんでした。');
    maker.Add_1(edge);
  }
  if (!maker.IsDone()) throw new Error('曲げ部分の輪郭がつながっていません。');
  const wire = keep(maker.Wire());
  if (!wire.Closed_1()) throw new Error('曲げ部分の輪郭が閉じていません。');
  if (direction > 0) wire.Reverse();
  return wire;
}

export function makeSheetMetalCurvedPanel(oc: OpenCascadeInstance, input: SheetMetalCurvedPanelInput): OcctShapeHandle {
  const { radius: r, thickness: t, neutralRadius: neutral, angle, frame } = input;
  if (![r, t, neutral, angle, r + t].every(Number.isFinite) || Math.min(r, t) <= 1e-7
    || neutral < r || neutral > r + t / 2 || Math.abs(angle) <= 1e-10 || Math.abs(angle) >= 180)
    throw new Error('曲げ部分の板厚・内半径・中立面と角度を確認してください。');
  validateSheetMetalBendFrame(frame);
  const { keep, release } = createAllocations();
  try {
    // 同じ輪郭で包含・自己交差・平面性を検査。円筒のパラメータ域外を一周へ巻き戻さない。
    const flat = keep(makeSheetMetalBase(oc, { outer: input.outer, holes: input.holes, thickness: 1, reversed: false, normal: [0, 0, 1] }));
    const bounds = keep(boundingBoxOf(oc, flat.shape)), range = boundingBoxRange(bounds.box);
    const length = neutral * Math.abs(angle) * Math.PI / 180;
    if (range.min[1] < -1e-6 || range.max[1] > length + 1e-6 || Math.abs(range.min[2]) > 1e-6)
      throw new Error('曲げ部分の輪郭が接線の間からはみ出しています。');
    const rectilinear = tryRectilinearBend(oc, input, measureVolume(oc, flat.shape));
    if (rectilinear !== null) {
      keep(rectilinear);
      return { shape: rectilinear.shape, delete: release };
    }
    const direction = angle < 0 ? -1 : 1, centerOffset = direction > 0 ? r + t : -r;
    const center = keep(new oc.gp_Pnt_3(frame.origin[0] + centerOffset * frame.normal[0],
      frame.origin[1] + centerOffset * frame.normal[1], frame.origin[2] + centerOffset * frame.normal[2]));
    const axis = keep(new oc.gp_Dir_4(direction * frame.xAxis[0], direction * frame.xAxis[1], direction * frame.xAxis[2]));
    const radial = keep(new oc.gp_Dir_4(-direction * frame.normal[0], -direction * frame.normal[1], -direction * frame.normal[2]));
    const axes = keep(new oc.gp_Ax3_3(center, axis, radial));
    const cylinder = keep(new oc.Geom_CylindricalSurface_1(axes, r)), surface = keep(new oc.Handle_Geom_Surface_2(cylinder));
    const outer = curvedWire(oc, input.outer, surface, neutral, direction, keep);
    const faceMaker = keep(new oc.BRepBuilderAPI_MakeFace_21(surface, outer, true));
    for (const hole of input.holes) faceMaker.Add(curvedWire(oc, hole, surface, neutral, direction, keep));
    if (!faceMaker.IsDone()) throw new Error('曲げ部分の面を作れませんでした。');
    const face = keep(faceMaker.Face());
    if (!isValidShape(oc, face)) throw new Error('曲げ部分の外周と穴が交差しています。');
    const thick = keep(new oc.BRepOffsetAPI_MakeThickSolid());
    thick.MakeThickSolidBySimple(face, t);
    if (!thick.IsDone()) throw new Error('曲げ部分へ一定の板厚を付けられませんでした。');
    const shape = keep(thick.Shape());
    if (!hasSolid(oc, shape) || !isValidShape(oc, shape)) throw new Error('穴や外周を含む曲げが有効な立体になりませんでした。');
    // Simpleの生成殻は内向きになる。新しく所有した結果だけを外向きへ揃える。
    const volume = measureVolume(oc, shape);
    if (!Number.isFinite(volume) || Math.abs(volume) <= 1e-9) throw new Error('曲げ部分の厚みが失われました。');
    if (volume < 0) shape.Reverse();
    return { shape, delete: release };
  } catch (error) { release(); throw error; }
}
