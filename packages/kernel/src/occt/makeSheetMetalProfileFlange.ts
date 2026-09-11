/** 任意の輪郭と穴を保ったまま、円筒帯を介して基板へ接続する。 */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';
import { makeSheetMetalBendBand, validateSheetMetalBendFrame, type SheetMetalBendBandInput } from './makeSheetMetalBend.js';
import { joinSheetMetalShapes } from './sheetMetalJoin.js';

export interface SheetMetalProfileFlangeInput extends SheetMetalBendBandInput {
  /** 折曲げ後の接線面へmodelが剛体配置した輪郭。単位はmm。 */
  readonly outer: readonly CurveSpec[];
  readonly holes: readonly (readonly CurveSpec[])[];
}

export function makeSheetMetalProfileFlange(oc: OpenCascadeInstance, target: TopoDS_Shape, input: SheetMetalProfileFlangeInput): OcctShapeHandle {
  validateSheetMetalBendFrame(input.frame);
  if (![input.thickness, input.radius, input.width, input.angle].every(Number.isFinite)
    || Math.min(input.thickness, input.radius, input.width) <= 1e-7 || Math.abs(input.angle) >= 180)
    throw new Error('任意輪郭フランジの板厚・内半径・幅・角度を確認してください。');
  const theta = input.angle * Math.PI / 180, c = Math.cos(theta), s = Math.sin(theta);
  const normal: Vec3Tuple = [
    input.frame.normal[0] * c - input.frame.yAxis[0] * s,
    input.frame.normal[1] * c - input.frame.yAxis[1] * s,
    input.frame.normal[2] * c - input.frame.yAxis[2] * s,
  ];
  const { keep, release } = createAllocations();
  try {
    const panel = keep(makeSheetMetalBase(oc, { outer: input.outer, holes: input.holes, thickness: input.thickness, normal, reversed: false }));
    let shape = target;
    if (input.angle !== 0) {
      const band = keep(makeSheetMetalBendBand(oc, input));
      shape = keep(joinSheetMetalShapes(oc, shape, band.shape)).shape;
    }
    shape = keep(joinSheetMetalShapes(oc, shape, panel.shape)).shape;
    return { shape, delete: release };
  } catch (error) { release(); throw error; }
}
