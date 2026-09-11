/** 展開板の同一平面を一面へまとめ、製作図へ内部の接線を切断線として出さない。 */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';

/** sourceは借用。コピーが必要な場合もOCCTのsafe input経路に任せ、元の面は変更しない。 */
export function unifySheetFlat(oc: OpenCascadeInstance, source: TopoDS_Shape, expectedVolume: number): OcctShapeHandle {
  const { keep, release } = createAllocations();
  try {
    const maker = keep(new oc.ShapeUpgrade_UnifySameDomain_1());
    maker.SetSafeInputMode(true);
    maker.Initialize(source, true, true, false);
    maker.SetLinearTolerance(1e-7); maker.SetAngularTolerance(1e-10);
    maker.AllowInternalEdges(false); maker.Build();
    const shape = keep(maker.Shape());
    if (shape.IsNull() || countSolidShapes(oc, shape) !== 1 || !isValidShape(oc, shape))
      throw new Error('展開の輪郭をまとめられませんでした。パネルと切欠きの接続を確認してください。');
    const volume = measureVolume(oc, shape);
    if (!Number.isFinite(volume) || !Number.isFinite(expectedVolume) || expectedVolume <= 0
      || Math.abs(volume - expectedVolume) > Math.max(1e-7, expectedVolume * 1e-10))
      throw new Error('展開の輪郭をまとめると体積が変わります。元のパネルを保持しました。');
    return { shape, delete: release };
  } catch (error) { release(); throw error; }
}
