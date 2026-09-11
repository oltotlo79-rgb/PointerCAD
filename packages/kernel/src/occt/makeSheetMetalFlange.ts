/** 基板の縁と曲げ帯を結合する。別立体・食込みを成功結果にしない。 */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeSheetMetalBendStrip, type SheetMetalBendStripInput } from './makeSheetMetalBend.js';
import { makeSheetMetalProfileFlange, type SheetMetalProfileFlangeInput } from './makeSheetMetalProfileFlange.js';
import { joinSheetMetalShapes } from './sheetMetalJoin.js';

export type SheetMetalFlangeInput = (SheetMetalBendStripInput & { readonly kind: 'rectangle' })
  | (SheetMetalProfileFlangeInput & { readonly kind: 'profile' });

/** targetは借用。失敗・解放後も呼び手が同じ形を使える。 */
export function makeSheetMetalFlange(
  oc: OpenCascadeInstance, target: TopoDS_Shape, input: SheetMetalBendStripInput,
): OcctShapeHandle {
  const { keep, release } = createAllocations();
  try {
    const bend = keep(makeSheetMetalBendStrip(oc, input));
    const joined = keep(joinSheetMetalShapes(oc, target, bend.shape));
    return { shape: joined.shape, delete: release };
  } catch (error) { release(); throw error; }
}

/** 複数縁を1つの履歴操作として結合する。途中失敗でも呼び手の元形は保持する。 */
export function makeSheetMetalFlanges(
  oc: OpenCascadeInstance, target: TopoDS_Shape, inputs: readonly SheetMetalFlangeInput[],
): OcctShapeHandle {
  if (inputs.length === 0) throw new Error('フランジを作る縁を1本以上選んでください。');
  const { keep, release } = createAllocations();
  try {
    let shape = target;
    for (const input of inputs) {
      switch (input.kind) {
        case 'rectangle': shape = keep(makeSheetMetalFlange(oc, shape, input)).shape; break;
        case 'profile': shape = keep(makeSheetMetalProfileFlange(oc, shape, input)).shape; break;
      }
    }
    return { shape, delete: release };
  } catch (error) { release(); throw error; }
}
