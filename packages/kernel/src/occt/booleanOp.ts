import type {
  BRepAlgoAPI_BooleanOperation,
  Message_ProgressRange,
  OpenCascadeInstance,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

// 和・差・積の別 BooleanOperation は、依頼の型と同じ場所(types.ts)に置いてある。
import type { BooleanOperation } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { isValidShape, measureVolume } from './solidMesh.js';

/**
 * これ未満の体積(mm³)は「何も残らなかった」とみなす。
 * 交わりが無いときの実測は厳密な 0 だが、接するだけの配置では丸めの残りかすが
 * 出ることがあるので、0 ではなく十分小さい値で切る。
 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

/** 演算そのものが成立しなかったとき(FR-504、NFR-RE-1)。 */
const COMBINE_FAILED_MESSAGE = '2 つの立体を組み合わせられませんでした。位置や形を見直してください。';

/** 演算はできたが立体が残らなかったとき(交わらない 2 体の積など)。 */
const NOTHING_LEFT_MESSAGE = '組み合わせた結果、立体が残りませんでした。';

/** 立体は残ったが B-rep として壊れているとき。 */
const INVALID_RESULT_MESSAGE =
  '組み合わせた立体の形が正しくありませんでした。位置や形を見直してください。';

/**
 * ブーリアンの結果。形と解放手続きに加えて、**演算のあとに測った体積**を持ち歩く。
 *
 * 体積は「立体が残らなかった」の判定(下の `MIN_SOLID_VOLUME_MM3`)のために
 * どのみち 1 回測る。同じ形を呼び出し側がもう一度測ると、その回数ぶん丸ごと無駄になる
 * (2026-09-05 実測: 面 26 枚・辺 72 本の板で 1 回 7.5〜11ms。穴の段では
 * `booleanOp` → `makeHole` の「削れた量」→ `buildSolidBodyMesh` の 3 回測っていた)。
 * 形はこのあと誰も作り変えないので、測り直しても必ず同じ値になる。
 */
export interface BooleanResult extends OcctShapeHandle {
  /** 結果の体積(mm³)。`measureVolume` と同じ測り方で、同じ形なら同じ値。 */
  readonly volume: number;
}

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

/** hasSolid と同じ判定。FindKey が返す形も含め、走査中の例外でも全て解放する。 */
function hasResultSolid(oc: OpenCascadeInstance, shape: TopoDS_Shape): boolean {
  const { keep, release } = createAllocations();
  try {
    const subShapes = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const count = subShapes.Size();
    for (let index = 1; index <= count; index += 1) {
      // FindKey の戻りは独立したラッパー。入力の TShape 自体は借用のまま。
      const subShape = keep(subShapes.FindKey(index));
      if (subShape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) {
        return true;
      }
    }
    return false;
  } finally {
    release();
  }
}

/** 結果に必要な所有は allocations に積み、入力リストはこの呼び出し中に解放する。 */
function buildBooleanResult(
  oc: OpenCascadeInstance,
  operation: BooleanOperation,
  target: TopoDS_Shape,
  tools: readonly TopoDS_Shape[],
  range: Message_ProgressRange,
  allocations: Allocations,
): BooleanResult {
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

  // 2026-09-03 の実測では、交わらない 2 体の積や、含まれる側から含む側を引いた結果も
  // IsDone() は true・HasErrors() は false で、中身が空の COMPOUND が返る
  // (体積 0、IsNull() は false)。空かどうかはここで別に確かめる。
  // ソリッドが 1 つも無ければ体積を測るまでもないので、順に見て早く抜ける
  // (測るのは 1 回だけで、その値は結果と一緒に返す。BooleanResult の注釈)。
  if (!hasResultSolid(oc, shape)) {
    throw new Error(NOTHING_LEFT_MESSAGE);
  }

  const volume = measureVolume(oc, shape);
  if (volume < MIN_SOLID_VOLUME_MM3) {
    throw new Error(NOTHING_LEFT_MESSAGE);
  }

  if (!isValidShape(oc, shape)) {
    throw new Error(INVALID_RESULT_MESSAGE);
  }

  return { shape, volume, delete: allocations.release };
}

/**
 * 2 つの立体の和・差・積(FR-404)。
 * 差は target から tool を引き、積は共通部分を残す。
 *
 * 結果の形は maker の中の実体を指すので、maker と進捗の入れ物を結果と一緒に生かしておき、
 * 返した handle の delete() で「結果の形 → maker → 進捗の入れ物」の順に解放する。
 *
 * **引数の target / tool は解放しない。** どちらも呼び出し側(形状キャッシュ)の持ち物で、
 * 演算のあとも別の段の入力として使われる。断ったときも同じで、この関数は引数に触れない。
 *
 * 返す値には、判定のために測った結果の体積が入る(`BooleanResult`)。
 * 呼び出し側は測り直さずにこの値を使う。
 */
export function booleanOp(
  oc: OpenCascadeInstance,
  operation: BooleanOperation,
  target: TopoDS_Shape,
  tool: TopoDS_Shape,
): BooleanResult {
  // 進捗の入れ物。2026-09-03 に Node で実測したところ、引数なしの
  // Message_ProgressRange_1 をそのまま渡して 3 種の演算とも成立した
  // (計画書 §1.2 の未確認点 4)。
  const allocations = createAllocations();
  try {
    const range = allocations.keep(new oc.Message_ProgressRange_1());
    return buildBooleanResult(oc, operation, target, [tool], range, allocations);
  } catch (error) {
    allocations.release();
    throw error;
  }
}

/** 全入力を一度に交差計算する。中間の結合体を繰り返し分割・検査しない。 */
export function unionShapes(oc: OpenCascadeInstance, shapes: readonly TopoDS_Shape[]): BooleanResult {
  if (shapes.length < 2) throw new Error('結合する立体を2つ以上指定してください。');
  const allocations = createAllocations();
  try {
    const range = allocations.keep(new oc.Message_ProgressRange_1());
    return buildBooleanResult(oc, 'union', shapes[0], shapes.slice(1), range, allocations);
  } catch (error) { allocations.release(); throw error; }
}
