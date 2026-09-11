/** 円筒曲げと接線直線部から、一定厚の板を生成する（P10-1）。 */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makePlanarFace } from './makePlanarFace.js';
import { hasSolid, isValidShape } from './solidMesh.js';

export interface SheetMetalLBendInput {
  readonly thickness: number; readonly radius: number; readonly width: number;
  /** 接線からの直線長mm。外寸・展開長とは別。 */
  readonly firstLength: number; readonly secondLength: number;
  /** degree。0は同じ厚みの平板。 */
  readonly angle: number;
}

/** 幅・基板から外へ向かう方向・基板法線の右手直交座標。長さを拡縮しない。 */
export interface SheetMetalBendFrame {
  readonly origin: Vec3Tuple; readonly xAxis: Vec3Tuple;
  readonly yAxis: Vec3Tuple; readonly normal: Vec3Tuple;
}
export interface SheetMetalBendStripInput extends Omit<SheetMetalLBendInput, 'firstLength'> {
  readonly frame: SheetMetalBendFrame;
}
export type SheetMetalBendBandInput = Omit<SheetMetalBendStripInput, 'secondLength'>;
const DEFAULT_FRAME: SheetMetalBendFrame = {
  origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1],
};
export function validateSheetMetalBendFrame(frame: SheetMetalBendFrame): void {
  const { origin, xAxis: x, yAxis: y, normal: n } = frame;
  const dot = (a: Vec3Tuple, b: Vec3Tuple): number => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const cross: Vec3Tuple = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  if (![...origin, ...x, ...y, ...n].every(Number.isFinite)
    || [x, y, n].some((axis) => Math.abs(dot(axis, axis) - 1) > 1e-10)
    || Math.abs(dot(x, y)) > 1e-10 || Math.abs(dot(x, n)) > 1e-10 || Math.abs(dot(y, n)) > 1e-10
    || Math.abs(dot(cross, n) - 1) > 1e-10) throw new Error('曲げの基準方向は右手系の直交単位ベクトルにしてください。');
}

/** 円筒曲げの断面を正確な円弧で囲み、幅方向へ押し出す。入力形状を破壊しない。 */
export function makeSheetMetalLBend(oc: OpenCascadeInstance, input: SheetMetalLBendInput): OcctShapeHandle {
  if (![input.firstLength, input.secondLength].every(Number.isFinite) || Math.min(input.firstLength, input.secondLength) <= 1e-7) throw new Error('基板とフランジの直線長を確認してください。');
  return buildBend(oc, input, DEFAULT_FRAME);
}

/** 基板との共有端面から始まる円筒曲げ＋フランジ。接続用の微小な重なりは足さない。 */
export function makeSheetMetalBendStrip(oc: OpenCascadeInstance, input: SheetMetalBendStripInput): OcctShapeHandle {
  if (!Number.isFinite(input.secondLength) || input.secondLength <= 1e-7) throw new Error('フランジの直線長を確認してください。');
  return buildBend(oc, { ...input, firstLength: 0 }, input.frame);
}

/** 任意輪郭へ接続する円筒帯だけ。直線長0を微小な長さへ置き換えない。 */
export function makeSheetMetalBendBand(oc: OpenCascadeInstance, input: SheetMetalBendBandInput): OcctShapeHandle {
  if (input.angle === 0) throw new Error('未曲げの板には円筒帯を作れません。平板の輪郭を使用してください。');
  return buildBend(oc, { ...input, firstLength: 0, secondLength: 0 }, input.frame);
}

function buildBend(oc: OpenCascadeInstance, input: SheetMetalLBendInput, frame: SheetMetalBendFrame): OcctShapeHandle {
  const { thickness: t, radius: r, width, firstLength: a, secondLength: b, angle } = input;
  if (![t, r, width, a, b, angle, r + t, r + t + b, width * t * (a + b + Math.PI * (r + t))].every(Number.isFinite)
    || Math.min(t, r, width) <= 1e-7 || a < 0 || b < 0 || (angle === 0 && a + b <= 1e-7)
    || Math.abs(angle) >= 180) throw new Error('板厚・内半径・幅・直線長と曲げ角を確認してください。');
  validateSheetMetalBendFrame(frame);
  const theta = Math.abs(angle) * Math.PI / 180, sign = angle < 0 ? -1 : 1, outerRadius = r + t;
  // 負曲げは板厚中央面に対する鏡映。基板のz=0..tは維持する。
  const point = (y: number, z: number): Vec3Tuple => {
    const mirrored = sign > 0 ? z : t - z;
    const result: Vec3Tuple = [
      frame.origin[0] + y * frame.yAxis[0] + mirrored * frame.normal[0],
      frame.origin[1] + y * frame.yAxis[1] + mirrored * frame.normal[1],
      frame.origin[2] + y * frame.yAxis[2] + mirrored * frame.normal[2],
    ];
    if (!result.every(Number.isFinite)) throw new Error('曲げの座標が扱える範囲を超えています。');
    return result;
  };
  const scale = (axis: Vec3Tuple, factor: number): Vec3Tuple => [axis[0] * factor, axis[1] * factor, axis[2] * factor];
  const outerEnd: readonly [number, number] = [outerRadius * Math.sin(theta), outerRadius * (1 - Math.cos(theta))];
  const innerEnd: readonly [number, number] = [r * Math.sin(theta), outerRadius - r * Math.cos(theta)];
  const advance = (p: readonly [number, number]): Vec3Tuple => point(p[0] + b * Math.cos(theta), p[1] + b * Math.sin(theta));
  const arc = (radius: number): CurveSpec => ({ kind: 'arc', center: point(0, outerRadius), normal: scale(frame.xAxis, sign),
    xAxis: scale(frame.normal, -sign), radius, startAngle: 0, endAngle: theta });
  const curves: CurveSpec[] = theta === 0 ? [
    { kind: 'segment', from: point(-a, 0), to: point(b, 0) },
    { kind: 'segment', from: point(b, 0), to: point(b, t) },
    { kind: 'segment', from: point(b, t), to: point(-a, t) },
    { kind: 'segment', from: point(-a, t), to: point(-a, 0) },
  ] : [
    ...(a === 0 ? [] : [{ kind: 'segment' as const, from: point(-a, 0), to: point(0, 0) }]), arc(outerRadius),
    ...(b === 0 ? [] : [{ kind: 'segment' as const, from: point(...outerEnd), to: advance(outerEnd) }]),
    { kind: 'segment', from: advance(outerEnd), to: advance(innerEnd) },
    ...(b === 0 ? [] : [{ kind: 'segment' as const, from: advance(innerEnd), to: point(...innerEnd) }]), arc(r),
    ...(a === 0 ? [] : [{ kind: 'segment' as const, from: point(0, t), to: point(-a, t) }]),
    { kind: 'segment', from: point(-a, t), to: point(-a, 0) },
  ];
  // MakeWireはつながる稜線の向きを揃える。内周側の円弧は同じ円弧を逆向きに使う。
  const { keep, release } = createAllocations();
  try {
    const face = keep(makePlanarFace(oc, curves));
    const vector = keep(new oc.gp_Vec_4(...scale(frame.xAxis, width)));
    const maker = keep(new oc.BRepPrimAPI_MakePrism_1(face.face, vector, false, true));
    if (!maker.IsDone()) throw new Error('板金の幅方向へ形を作れませんでした。');
    const shape = keep(maker.Shape());
    if (!hasSolid(oc, shape) || !isValidShape(oc, shape)) throw new Error('曲げた板金が有効な立体になりませんでした。');
    return { shape, delete: release };
  } catch (error) { release(); throw error; }
}
