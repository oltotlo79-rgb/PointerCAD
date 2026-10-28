import type {
  Message_ProgressRange,
  OpenCascadeInstance,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

// 和・差・積の別 BooleanOperation は、依頼の型と同じ場所(types.ts)に置いてある。
import type { BooleanHistory } from './ellipseBoolean.js';
import type { BooleanOperation } from '../types.js';
import type { Allocations } from './allocations.js';
import { buildBooleanShape } from './buildBooleanShape.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { OPEN_FACES_NOT_SUPPORTED, shapeBodyKind } from './shapeBodyKind.js';
import type { CurrentOriginIndex } from '../subShapeOrigin.js';
import { extractSubShapeHistory, OriginHistoryLimitError } from './subShapeHistory.js';
import { holeOperationOrigins, type NativeHoleToolFace } from './subShapeOrigins.js';
import { semanticOperationOrigins } from './semanticOperationOrigins.js';

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

/** 差で何も削れなかったとき(EX04。`requireRemoval` を立てた差だけが断る)。 */
export const NOTHING_REMOVED_MESSAGE =
  '切る輪郭が立体に届かず、何も削れませんでした。輪郭の位置や大きさを見直してください。';

/**
 * 輪郭の内側を残す積で、輪郭が立体に届かず内側に何も残らなかったとき
 * (EX-04 W3。`requireRemoval` を立てた積だけが断る)。
 */
export const NOTHING_INSIDE_MESSAGE =
  '切る輪郭が立体に届かず、輪郭の内側に何も残りませんでした。輪郭の位置や大きさを見直してください。';

/**
 * 輪郭の内側を残す積で、立体がまるごと輪郭の中にあり何も削れなかったとき
 * (EX-04 W3。`requireRemoval` を立てた積だけが断る)。
 */
export const NOTHING_OUTSIDE_MESSAGE =
  '切る輪郭が立体をまるごと囲んでいて、何も削れませんでした。輪郭の位置や大きさを見直してください。';

/** ブーリアンの任意の条件。省略すると従来どおり(何も削れない差・積も成立させる)。 */
export interface BooleanOptions {
  /**
   * true なら、閉じた輪郭の切断として実際に立体を切り分けることを求める(EX04、EX-04 W3)。
   * - 差(輪郭の外側を残す): 対象と相手の共通部分に立体が無いとき `NOTHING_REMOVED_MESSAGE` で断る。
   * - 積(輪郭の内側を残す): 共通部分に立体が無いとき `NOTHING_INSIDE_MESSAGE`、対象から相手を
   *   引いた残り(輪郭の外側)に立体が無いとき `NOTHING_OUTSIDE_MESSAGE` で断る。
   * - 和には効かない(従来どおり)。
   *
   * 差は「共通部分あり」と「結果あり(= 外側あり)」、積は「結果あり(= 共通部分あり)」と「外側あり」を
   * 確かめるので、同じ対象と相手の差と積は**そろって成立するか、そろって断る**(両方を残す対の前提)。
   */
  readonly requireRemoval?: true;
}

/**
 * 差で実際に削れるものがあるかを確かめる。共通部分を非破壊で作り(入力の形には触れない)、
 * 立体が無いか体積が `MIN_SOLID_VOLUME_MM3`(「何も残らなかった」と同じ境目)未満なら断る。
 * 境界箱が重なるだけでは「削れる」証拠にならないので、実際の形どうしで確かめる。
 */
function assertRemovesMaterial(oc: OpenCascadeInstance, target: TopoDS_Shape, tool: TopoDS_Shape): void {
  assertSolidRemains(oc, 'intersect', target, tool, NOTHING_REMOVED_MESSAGE);
}

/**
 * 輪郭の内側を残す積(EX-04 W3)で、輪郭の外側に削り取るものがあるかを確かめる。対象から相手を引いた
 * 残りを非破壊で作り(入力の形には触れない)、立体が無いか体積が `MIN_SOLID_VOLUME_MM3` 未満なら
 * `NOTHING_OUTSIDE_MESSAGE` で断る(差の `assertRemovesMaterial` と同じ境目・同じ作り方)。
 */
function assertKeepsOutside(oc: OpenCascadeInstance, target: TopoDS_Shape, tool: TopoDS_Shape): void {
  assertSolidRemains(oc, 'subtract', target, tool, NOTHING_OUTSIDE_MESSAGE);
}

/** `operation` の結果を非破壊で作り、立体が残らなければ `message` で断る。作った形はここで解放する。 */
function assertSolidRemains(oc: OpenCascadeInstance, operation: BooleanOperation, target: TopoDS_Shape,
  tool: TopoDS_Shape, message: string): void {
  const owned = createAllocations();
  try {
    const range = owned.keep(new oc.Message_ProgressRange_1());
    // Even a no-op native Boolean can freeze shared input TShapes in non-destructive mode.
    // This is only a disposable material-presence probe; it needs no borrowed topology/history.
    const copy = (shape: TopoDS_Shape): TopoDS_Shape => {
      const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(shape, true, true));
      if (!copier.IsDone()) throw new Error(COMBINE_FAILED_MESSAGE);
      const copied = owned.keep(copier.Shape());
      if (copied.IsNull() || copied.IsSame(shape)) throw new Error(COMBINE_FAILED_MESSAGE);
      return copied;
    };
    const result = buildBooleanShape(oc, operation, copy(target), [copy(tool)], range, owned);
    if (!hasResultSolid(oc, result) || measureVolume(oc, result) < MIN_SOLID_VOLUME_MM3) {
      throw new Error(message);
    }
  } finally {
    owned.release();
  }
}

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

/** A machining tool can be unnamed; only the tracked target identities are then inherited. */
export interface BooleanSemanticContext {
  readonly featureId: string;
  readonly target: CurrentOriginIndex;
  readonly tool?: CurrentOriginIndex;
  readonly newHoleFaces?: readonly NativeHoleToolFace[];
}

type NativeBooleanObserver = (maker: BooleanHistory, output: TopoDS_Shape) => void;

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
  semantic?: BooleanSemanticContext,
  onBuilt?: NativeBooleanObserver,
): BooleanResult {
  let origins: CurrentOriginIndex | undefined;
  const shape = buildBooleanShape(oc, operation, target, tools, range, allocations,
    semantic === undefined && onBuilt === undefined ? undefined : (maker, output) => {
      onBuilt?.(maker, output);
      if (semantic === undefined || tools.length !== 1) return;
      const allowUntrackedRegions = operation === 'subtract' && semantic.newHoleFaces !== undefined;
      if ((semantic.target.state !== 'tracked' && !allowUntrackedRegions)
        || (semantic.tool !== undefined && semantic.tool.state !== 'tracked')) {
        origins = { version: 1, state: 'untracked', reason: 'unsupported-operation' };
        return;
      }
      try {
        const inputs = [{ sourceId: 'target', shape: target },
          ...(semantic.tool === undefined ? [] : [{ sourceId: 'tool', shape: tools[0] }])];
        const history = extractSubShapeHistory(oc, maker, inputs, output);
        origins = semanticOperationOrigins(semantic.featureId, [
          { sourceId: 'target', origins: semantic.target },
          ...(semantic.tool === undefined ? [] : [{ sourceId: 'tool', origins: semantic.tool,
            ...(target.IsSame(tools[0]) ? { aliasOf: 'target' } : {}) }]),
        ], history, undefined, { allowUntrackedRegions });
        if (operation === 'subtract' && semantic.newHoleFaces !== undefined) {
          origins = holeOperationOrigins(oc, maker, output, tools[0], origins, semantic.newHoleFaces, semantic.featureId);
        }
      } catch (error) {
        origins = { version: 1, state: 'untracked',
          reason: error instanceof OriginHistoryLimitError ? 'limit' : 'missing-native-map' };
      }
    });
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

  return { shape, volume, ...(origins === undefined ? {} : { origins }), delete: allocations.release };
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
  semantic?: BooleanSemanticContext,
  onBuilt?: NativeBooleanObserver,
  options?: BooleanOptions,
): BooleanResult {
  // 進捗の入れ物。2026-09-03 に Node で実測したところ、引数なしの
  // Message_ProgressRange_1 をそのまま渡して 3 種の演算とも成立した
  // (計画書 §1.2 の未確認点 4)。
  const allocations = createAllocations();
  try {
    const range = allocations.keep(new oc.Message_ProgressRange_1());
    if (target.IsNull() || tool.IsNull()) throw new Error(COMBINE_FAILED_MESSAGE);
    if (shapeBodyKind(oc, target) !== 'solid' || shapeBodyKind(oc, tool) !== 'solid') throw new Error(OPEN_FACES_NOT_SUPPORTED);
    if (options?.requireRemoval === true && operation === 'subtract') assertRemovesMaterial(oc, target, tool);
    if (options?.requireRemoval === true && operation === 'intersect') {
      // 輪郭の内側を残す(EX-04 W3)。外側に削るものが無い(輪郭が立体をまるごと囲む)なら断る。
      assertKeepsOutside(oc, target, tool);
      // Refuse an empty inside on copied topology before the real Common touches borrowed inputs.
      assertSolidRemains(oc, 'intersect', target, tool, NOTHING_INSIDE_MESSAGE);
      return buildInsideResult(() => buildBooleanResult(oc, operation, target, [tool], range, allocations, semantic, onBuilt));
    }
    return buildBooleanResult(oc, operation, target, [tool], range, allocations, semantic, onBuilt);
  } catch (error) {
    allocations.release();
    throw error;
  }
}

/**
 * 輪郭の内側を残す積の結果を作る(EX-04 W3)。共通部分に立体が無いときの断り(`NOTHING_LEFT_MESSAGE`)
 * だけを、輪郭が届かなかったことを伝える `NOTHING_INSIDE_MESSAGE` に置き換える(他の断りはそのまま)。
 */
function buildInsideResult(build: () => BooleanResult): BooleanResult {
  try {
    return build();
  } catch (error) {
    if (error instanceof Error && error.message === NOTHING_LEFT_MESSAGE) {
      throw new Error(NOTHING_INSIDE_MESSAGE, { cause: error });
    }
    throw error;
  }
}

/** 全入力を一度に交差計算する。中間の結合体を繰り返し分割・検査しない。 */
export function unionShapes(oc: OpenCascadeInstance, shapes: readonly TopoDS_Shape[]): BooleanResult {
  if (shapes.length < 2) throw new Error('結合する立体を2つ以上指定してください。');
  const allocations = createAllocations();
  try {
    const range = allocations.keep(new oc.Message_ProgressRange_1());
    if (shapes.some(shape => shape.IsNull())) throw new Error(COMBINE_FAILED_MESSAGE);
    if (shapes.some(shape => shapeBodyKind(oc, shape) !== 'solid')) throw new Error(OPEN_FACES_NOT_SUPPORTED);
    return buildBooleanResult(oc, 'union', shapes[0], shapes.slice(1), range, allocations);
  } catch (error) { allocations.release(); throw error; }
}
