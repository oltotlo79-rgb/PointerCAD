import type {
  BRepAlgoAPI_BooleanOperation, Message_ProgressRange, OpenCascadeInstance, TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';
import type { BooleanOperation } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';

const COMBINE_FAILED_MESSAGE = '2 つの立体を組み合わせられませんでした。位置や形を見直してください。';

/**
 * 演算前に非破壊モードを指定できるよう、空の maker を作る。
 * 2026-09-07 に固定 WASM で、引数なしの構築 → 入力指定 → Build を3演算とも実証。
 * 各節は return で閉じる(no-fallthrough)。
 */
function createBooleanMaker(
  oc: OpenCascadeInstance,
  operation: BooleanOperation,
): BRepAlgoAPI_BooleanOperation {
  switch (operation) {
    case 'union':
      return new oc.BRepAlgoAPI_Fuse_1();
    case 'subtract':
      return new oc.BRepAlgoAPI_Cut_1();
    case 'intersect':
      return new oc.BRepAlgoAPI_Common_1();
  }
}

/** 非破壊の実Booleanを作る。空結果の扱いは呼出し側の用途で判定する。 */
export function buildBooleanShape(
  oc: OpenCascadeInstance, operation: BooleanOperation, target: TopoDS_Shape,
  tools: readonly TopoDS_Shape[], range: Message_ProgressRange, allocations: Allocations,
): TopoDS_Shape {
  const maker = allocations.keep(createBooleanMaker(oc, operation));
  const inputs = createAllocations();
  try {
    const argumentsList = inputs.keep(new oc.TopTools_ListOfShape_1());
    const toolsList = inputs.keep(new oc.TopTools_ListOfShape_1());
    // Append_1 は入力と別のラッパーを返す(2026-09-07 固定 WASM 実測)。
    // その戻りも解放するが、target / tool の所有は移さない。
    inputs.keep(argumentsList.Append_1(target));
    for (const tool of tools) inputs.keep(toolsList.Append_1(tool));
    maker.SetArguments(argumentsList);
    maker.SetTools(toolsList);
    // Build より前に立て、許容値や pcurve の更新をキャッシュの入力へ書き戻させない。
    maker.SetNonDestructive(true);
    maker.Build(range);
  } finally {
    inputs.release();
  }

  // 成否は HasErrors() と IsDone() だけで見る。Error() の戻り値は
  // 型定義で空の型 `{}` になっており、比較に強制変換が要るため使わない
  // (makePlanarFace.ts と同じ理由)。
  if (maker.HasErrors() || !maker.IsDone()) {
    throw new Error(COMBINE_FAILED_MESSAGE);
  }

  const shape = allocations.keep(maker.Shape());

  return shape;
}
