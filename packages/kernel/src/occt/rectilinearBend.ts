/** 軸に平行な展開輪郭を、厳密な円弧断面の押し出しで構築する。 */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { unionShapes } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeSheetMetalBendBand, type SheetMetalBendFrame } from './makeSheetMetalBend.js';
import type { SheetMetalCurvedPanelInput } from './makeSheetMetalCurvedPanel.js';
import { isValidShape, measureVolume } from './solidMesh.js';

interface Strip { readonly from: number; readonly to: number; readonly low: number; readonly high: number }
const AXIS_TOLERANCE_MM = 1e-10;

function stripsOf(loops: readonly (readonly CurveSpec[])[]): readonly Strip[] | null {
  const segments: Extract<CurveSpec, { kind: 'segment' }>[] = [];
  for (const loop of loops) for (const curve of loop) {
    if (curve.kind !== 'segment') return null;
    if (Math.abs(curve.from[0] - curve.to[0]) > AXIS_TOLERANCE_MM && Math.abs(curve.from[1] - curve.to[1]) > AXIS_TOLERANCE_MM) return null;
    segments.push(curve);
  }
  const coordinates = [...new Set(segments.flatMap((edge) => [edge.from[0], edge.to[0]]))].sort((a,b) => a-b);
  if (coordinates.length > 128) return null;
  const strips: Strip[] = [];
  for (let i = 1; i < coordinates.length; i++) {
    const from = coordinates[i-1], to = coordinates[i];
    if (to - from <= AXIS_TOLERANCE_MM) continue;
    const mid = (from + to) / 2;
    const crossings = segments.filter((edge) => Math.min(edge.from[0], edge.to[0]) < mid && mid < Math.max(edge.from[0], edge.to[0]))
      .map((edge) => (edge.from[1] + edge.to[1]) / 2).sort((a,b) => a-b);
    if (crossings.length % 2 !== 0) return null;
    for (let j = 0; j < crossings.length; j += 2) {
      if (crossings[j+1] - crossings[j] <= 1e-7 || to - from <= 1e-7) return null;
      strips.push({ from, to, low: crossings[j], high: crossings[j+1] });
    }
  }
  return strips.length === 0 ? null : strips;
}

function stripFrame(input: SheetMetalCurvedPanelInput, strip: Strip): SheetMetalBendFrame {
  const { frame, radius, thickness } = input, sign = input.angle < 0 ? -1 : 1;
  const theta = strip.low / input.neutralRadius, c = Math.cos(theta), s = Math.sin(theta);
  const baseRadius = sign < 0 ? radius : radius + thickness;
  const combine = (x: number, y: number, z: number): Vec3Tuple => [
    x * frame.xAxis[0] + y * frame.yAxis[0] + z * frame.normal[0],
    x * frame.xAxis[1] + y * frame.yAxis[1] + z * frame.normal[1],
    x * frame.xAxis[2] + y * frame.yAxis[2] + z * frame.normal[2],
  ];
  const shift = combine(strip.from, baseRadius * s, sign * baseRadius * (1-c));
  return { origin: [frame.origin[0]+shift[0], frame.origin[1]+shift[1], frame.origin[2]+shift[2]],
    xAxis: frame.xAxis, yAxis: combine(0,c,sign*s), normal: combine(0,-sign*s,c) };
}

/** 非直交の線・円弧・楕円・スプラインは元の円筒面処理へ渡す。入力は平面側で検証済み。 */
export function tryRectilinearBend(oc: OpenCascadeInstance, input: SheetMetalCurvedPanelInput, flatArea: number): OcctShapeHandle | null {
  const strips = stripsOf([input.outer, ...input.holes]); if (strips === null) return null;
  const { keep, release } = createAllocations();
  try {
    const parts = strips.map((strip) => keep(makeSheetMetalBendBand(oc, {
      frame: stripFrame(input, strip), thickness: input.thickness, radius: input.radius, width: strip.to-strip.from,
      angle: Math.sign(input.angle) * (strip.high-strip.low) / input.neutralRadius * 180 / Math.PI,
    })));
    const joined = parts.length > 1 ? keep(unionShapes(oc, parts.map((part) => part.shape))) : null;
    const shape = joined?.shape ?? parts[0].shape, volume = joined?.volume ?? measureVolume(oc, shape);
    const expected = flatArea * input.thickness * (input.radius + input.thickness / 2) / input.neutralRadius;
    if (!isValidShape(oc, shape) || !Number.isFinite(volume) || Math.abs(volume-expected) > Math.max(1e-7, expected * 1e-10))
      throw new Error('曲げ部分の輪郭と厚みが一致しません。');
    return { shape, delete: release };
  } catch (error) { release(); throw error; }
}
