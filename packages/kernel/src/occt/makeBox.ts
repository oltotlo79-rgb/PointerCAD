import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { BoxParameters } from '../types.js';

/** OCCT の形状と、その形状を作るために確保した領域の解放手続き。 */
export interface OcctShapeHandle {
  readonly shape: TopoDS_Shape;
  delete(): void;
}

/**
 * 原点を角とする直方体を作る(FR-401 の押し出しに先立つ P0 の確認用形状)。
 * 単位は mm(NFR-RE-3)。
 */
export function makeBox(oc: OpenCascadeInstance, parameters: BoxParameters): OcctShapeHandle {
  const { dx, dy, dz } = parameters;
  if (!(dx > 0) || !(dy > 0) || !(dz > 0)) {
    throw new Error(`箱の寸法は正の数である必要があります: dx=${dx}, dy=${dy}, dz=${dz}`);
  }

  const maker = new oc.BRepPrimAPI_MakeBox_2(dx, dy, dz);
  const shape = maker.Shape();

  return {
    shape,
    delete(): void {
      shape.delete();
      maker.delete();
    },
  };
}
