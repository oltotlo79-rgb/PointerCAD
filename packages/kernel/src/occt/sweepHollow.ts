/**
 * スイープの中空(M-07)。内側の線を作り、外と同じ置き方・同じ向き・同じ断面の列で掃いた立体を、外の立体から引く。
 *
 * - 肉厚 t: 平面の断面の線を `makeOffsetWire`(BRepOffsetAPI_MakeOffset。角は円弧でつなぐ)で ±t ずらし、
 *   閉じた線 1 本で、面積が正で外より小さい方を採る(輪郭の向きで内外の符号が変わるため両方を試す)。採れない時は断る。
 * - 穴つきの面: 面の穴の線(解決済みの閉ループ)をそのまま使う。
 * - 肉厚と穴は同時に使えない(どちらの内側か決まらない)。
 * - 引く前に、外と内のそれぞれが正しい立体かを確かめる。正しくない形どうしを引くと、引く処理が長く止まる(試作で 80 秒)。
 * - 引いた後も、正しい立体がちょうど 1 つかを確かめる。
 * 先細りでは、断面の写しが相似なので、壁の厚みも同じ割合で細る。
 */
import type { OpenCascadeInstance, TopoDS_Shape, TopoDS_Wire } from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec } from '../types.js';
import type { Allocations } from './allocations.js';
import { SolidGeometryFailure } from './solidGeometryFailure.js';
import { sketchInputReason } from './kernelStepError.js';
import { makeOffsetWire, type OffsetContour } from './makeOffsetWire.js';
import { countSolidShapes } from './solidTopology.js';
import { hasSolid, isValidShape, measureArea } from './solidMesh.js';

const WALL_TOO_THICK_MESSAGE = '肉厚が断面に対して大きすぎます。肉厚を小さくしてください。';
const WALL_WITH_HOLES_MESSAGE = '穴つきの面を断面にする時は、肉厚を使えません。';
const WALL_VALUE_MESSAGE = '肉厚は0より大きい長さにしてください。';
const HOLE_NOT_CONNECTED_MESSAGE = '断面の穴の線がつながっていないため、中空にできませんでした。';
const INNER_NOT_CONNECTED_MESSAGE = '肉厚でずらした内側の線がつながらないため、中空にできませんでした。';
const INVALID_BEFORE_CUT_MESSAGE = '中空にする前の形が正しくないため、中空にできませんでした。断面と道筋を見直してください。';
const CUT_FAILED_MESSAGE = '内側を引けませんでした。肉厚と断面を見直してください。';

/** 中空の指定(段の欄のうち、内側の線に要る物)。 */
interface SweepHollowSpec {
  readonly profile: readonly CurveSpec[];
  readonly holes?: readonly (readonly CurveSpec[])[];
  readonly wallThickness?: number;
}

/** 内側の線と、その面積の合計(体積の確かめに使う)。 */
interface SweepInnerProfiles {
  readonly wires: readonly TopoDS_Wire[];
  readonly area: number;
}

/** 線に平らな面を張って面積を測る。張れない線は null。 */
function wireArea(oc: OpenCascadeInstance, wire: TopoDS_Wire, keep: Allocations['keep']): number | null {
  const faceMaker = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));
  return faceMaker.IsDone() ? measureArea(oc, keep(faceMaker.Face())) : null;
}

/** 線をずらした輪郭。内側へ寄せすぎて潰れた向きは null(もう一方の符号を試す)。 */
function offsetContours(oc: OpenCascadeInstance, curves: readonly CurveSpec[], distance: number): readonly OffsetContour[] | null {
  try {
    return makeOffsetWire(oc, { curves, distance, joinType: 'arc' });
  } catch (error) {
    // An offset refusal permits trying the other side. Native or programming faults do not.
    if (error instanceof Error && sketchInputReason(error) !== undefined) return null;
    throw error;
  }
}

/**
 * 内側の線を作る。中空でなければ空。`buildWire` は makeSweep.ts の線の組み立て(つながらない時は渡した理由で断る)。
 */
export function innerProfileWires(oc: OpenCascadeInstance, spec: SweepHollowSpec, outerArea: number,
  buildWire: (curves: readonly CurveSpec[], disconnect: () => SolidGeometryFailure) => TopoDS_Wire, keep: Allocations['keep']): SweepInnerProfiles {
  const holes = spec.holes ?? [];
  if (holes.length > 0 && spec.wallThickness !== undefined) throw new SolidGeometryFailure('geometry-pathSweep-wall-with-holes', WALL_WITH_HOLES_MESSAGE);
  if (spec.wallThickness === undefined) {
    const wires = holes.map((hole) => buildWire(hole,
      () => new SolidGeometryFailure('geometry-pathSweep-hole-disconnected', HOLE_NOT_CONNECTED_MESSAGE)));
    const area = wires.reduce((sum, wire) => sum + (wireArea(oc, wire, keep) ?? 0), 0);
    return { wires, area };
  }
  const wall = spec.wallThickness;
  if (!Number.isFinite(wall) || !(wall > 0)) throw new SolidGeometryFailure('geometry-pathSweep-wall-value', WALL_VALUE_MESSAGE);
  for (const distance of [-wall, wall]) {
    const closed = (offsetContours(oc, spec.profile, distance) ?? []).filter((contour) => contour.closed);
    if (closed.length !== 1) continue;
    const wire = buildWire(closed[0].curves,
      () => new SolidGeometryFailure('geometry-pathSweep-offset-disconnected', INNER_NOT_CONNECTED_MESSAGE));
    const area = wireArea(oc, wire, keep);
    if (area !== null && area > 1e-9 && area < outerArea) return { wires: [wire], area };
  }
  throw new SolidGeometryFailure('geometry-pathSweep-wall-too-thick', WALL_TOO_THICK_MESSAGE);
}

/** 外の立体から内側の立体を引く。引く前と後に正しさを確かめる。 */
export function cutInnerSolids(oc: OpenCascadeInstance, outer: TopoDS_Shape, inners: readonly TopoDS_Shape[],
  keep: Allocations['keep']): TopoDS_Shape {
  if (!isValidShape(oc, outer)) throw new Error(INVALID_BEFORE_CUT_MESSAGE);
  let shape = outer;
  for (const inner of inners) {
    if (!isValidShape(oc, inner) || !hasSolid(oc, inner)) throw new Error(INVALID_BEFORE_CUT_MESSAGE);
    const cutter = keep(new oc.BRepAlgoAPI_Cut_3(shape, inner, keep(new oc.Message_ProgressRange_1())));
    if (!cutter.IsDone()) throw new SolidGeometryFailure('geometry-pathSweep-hollow-cut', CUT_FAILED_MESSAGE);
    shape = keep(cutter.Shape());
  }
  if (!isValidShape(oc, shape) || countSolidShapes(oc, shape) !== 1) throw new SolidGeometryFailure('geometry-pathSweep-hollow-cut', CUT_FAILED_MESSAGE);
  return shape;
}
