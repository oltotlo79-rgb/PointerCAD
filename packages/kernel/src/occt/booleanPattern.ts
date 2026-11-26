/**
 * 並べる和・差(M-04、FR-411 / FR-412 のパターンを押し出し・回転・基本形状などへ広げた分)。
 *
 * 工具の立体を変換ごとに写し(`transformShape`、幾何ごとの複製)、写しの全部を 1 回の和か差の工具にする。
 * 穴・ねじ穴のパターン(makeHole.ts の makeHoleTools)と同じ考え方で、段の種類は増やさず、和・差の段の
 * `transforms` の欄だけで表す(types.ts の BooleanStepSpec)。工具そのものは使わない(もとの位置の分は、
 * 対象がすでに持っている)。
 *
 * - 写しが 0 個(点で並べて 1 点だけのとき): 対象を写して返す。名前の継ぎは写しへ移す(rebindTransformedOrigins)。
 * - 写しが 1 個以上: 対象も写してから組み合わせる(何も削れない写しがあると、非破壊の指定でも入力の形が
 *   凍りうる。makeHole.ts の workingTarget と同じ理由)。名前の継ぎは、対象から来た面・辺・頂点の名前だけを継ぎ、
 *   写しから来た物には名前を付けない(名前の無い工具の和・差と同じ扱い。booleanOp.ts の BooleanSemanticContext の
 *   tool を省いた形)。写しの物への参照は、今までどおり指紋で選び直す。保存の参照の形は変えない。
 * - 和で立体が 2 つ以上に分かれたら断る(並べた写しが対象から離れている)。差は今の差と同じ判定だけ。
 *
 * **引数の対象・工具は解放しない**(形状キャッシュの持ち物。booleanOp と同じ約束)。
 */
import type { BRepBuilderAPI_Copy, OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { CurrentOriginIndex } from '../subShapeOrigin.js';
import type { BooleanStepSpec, RigidTransformSpec } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { booleanOpWithTools, type BooleanResult } from './booleanOp.js';
import type { BooleanHistory } from './ellipseBoolean.js';
import { semanticOperationOrigins } from './semanticOperationOrigins.js';
import { OPEN_FACES_NOT_SUPPORTED, shapeBodyKind } from './shapeBodyKind.js';
import { measureVolume } from './solidMesh.js';
import { extractSubShapeHistory, OriginHistoryLimitError } from './subShapeHistory.js';
import { rebindTransformedOrigins } from './subShapeOrigins.js';
import { releaseGeometryOnError, SolidGeometryFailure } from './solidGeometryFailure.js';
import { transformShape } from './transformShape.js';

/** 写しの数の上限。model の並べる個数の上限(MAX_PATTERN_COUNT = 100、もとを含む)から、もとの 1 つを引いた数。 */
const MAX_PATTERN_COPIES = 99;

/** 並べた和で、写しの一部が対象とつながらずに別の立体として残ったとき。 */
const DETACHED_COPIES_MESSAGE = '並べた立体の一部が、元の立体から離れています。間隔や個数を見直してください。';

/** 形を写せなかったとき(OCCT の複製が成り立たない。ふつうは起きない)。 */
const COPY_FAILED_MESSAGE = '並べる立体を写せませんでした。元の立体を見直してください。';

/** 和・差の段のうち、並べるが読む欄。 */
type PatternBooleanFields = Pick<BooleanStepSpec, 'operation' | 'requireRemoval'>;

/** model が守る約束の確かめ。破れたら組み立て側の取りこぼしなので、利用者向けの文ではなく RangeError で止める。 */
function assertPatternContract(spec: PatternBooleanFields, transforms: readonly RigidTransformSpec[]): 'union' | 'subtract' {
  if (spec.operation === 'intersect') throw new RangeError('Boolean pattern supports union and subtract only');
  if (spec.requireRemoval === true) throw new RangeError('Boolean pattern cannot require removal');
  if (transforms.length > MAX_PATTERN_COPIES) throw new RangeError('Boolean pattern exceeds the copy limit');
  return spec.operation;
}

/** 形を幾何ごと写す。写しと複製の道具は owned が持つ。 */
function copyShape(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations):
  { readonly copier: BRepBuilderAPI_Copy; readonly copied: TopoDS_Shape } {
  const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(shape, true, true));
  if (!copier.IsDone()) {
    throw new SolidGeometryFailure('geometry-internal', COPY_FAILED_MESSAGE, undefined,
      { cause: { phase: 'pattern-copy', isDone: false } });
  }
  const copied = owned.keep(copier.Shape());
  const isNull = copied.IsNull();
  const isSame = !isNull && copied.IsSame(shape);
  if (isNull || isSame) {
    throw new SolidGeometryFailure('geometry-internal', COPY_FAILED_MESSAGE, undefined,
      { cause: { phase: 'pattern-copy', isNull, isSame } });
  }
  return { copier, copied };
}

/** 結果に含まれる立体(SOLID)の数。FindKey の包みは呼び出しの中で解放する。 */
function countSolids(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const scratch = createAllocations();
  try {
    const members = scratch.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, members, true, true);
    let solids = 0;
    for (let index = 1; index <= members.Size(); index += 1) {
      if (scratch.keep(members.FindKey(index)).ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) solids += 1;
    }
    return solids;
  } finally {
    scratch.release();
  }
}

/** 写しが 0 個: 対象の写しを結果にする。体積は測り、名前の継ぎは写しへ移す。 */
function carryTarget(oc: OpenCascadeInstance, target: TopoDS_Shape, targetOrigins: CurrentOriginIndex | undefined): BooleanResult {
  const owned = createAllocations();
  try {
    const { copier, copied } = copyShape(oc, target, owned);
    const origins = targetOrigins === undefined ? undefined : rebindTransformedOrigins(oc, targetOrigins, target, copier, copied);
    return { shape: copied, volume: measureVolume(oc, copied), ...(origins === undefined ? {} : { origins }), delete: owned.release };
  } catch (error) {
    releaseGeometryOnError(owned.release, error);
  }
}

/**
 * 対象から来た物の名前だけを継ぐ(写しは入力に入れない)。作り手の履歴が読めない・上限を超えたときは、
 * 工具 1 個の和・差(booleanOp.ts の buildBooleanResult)と同じ理由で名前の継ぎを諦める。
 */
function targetIdentities(oc: OpenCascadeInstance, featureId: string, workingTarget: TopoDS_Shape,
  workingOrigins: CurrentOriginIndex, maker: BooleanHistory, output: TopoDS_Shape): CurrentOriginIndex {
  try {
    const history = extractSubShapeHistory(oc, maker, [{ sourceId: 'target', shape: workingTarget }], output);
    return semanticOperationOrigins(featureId, [{ sourceId: 'target', origins: workingOrigins }], history);
  } catch (error) {
    return { version: 1, state: 'untracked', reason: error instanceof OriginHistoryLimitError ? 'limit' : 'missing-native-map' };
  }
}

/** 名前を継ぐ所(対象の段の名前の継ぎがあり、段の id が分かるときだけ)。 */
interface NamingContext {
  readonly featureId: string;
  readonly targetOrigins: CurrentOriginIndex;
}

/** 写しが 1 個以上: 対象と工具の写しを作り、1 回で組み合わせる。写しは結果を手放すまで生かす。 */
function combineCopies(oc: OpenCascadeInstance, operation: 'union' | 'subtract', target: TopoDS_Shape, tool: TopoDS_Shape,
  transforms: readonly RigidTransformSpec[], naming: NamingContext | undefined): BooleanResult {
  const owned = createAllocations();
  try {
    const { copier, copied: workingTarget } = copyShape(oc, target, owned);
    const workingOrigins = naming === undefined ? undefined
      : rebindTransformedOrigins(oc, naming.targetOrigins, target, copier, workingTarget);
    const copies = transforms.map(transform => owned.keep(transformShape(oc, tool, transform)).shape);
    let origins: CurrentOriginIndex | undefined;
    const result = booleanOpWithTools(oc, operation, workingTarget, copies, naming === undefined || workingOrigins === undefined
      ? undefined : (maker, output) => { origins = targetIdentities(oc, naming.featureId, workingTarget, workingOrigins, maker, output); });
    let solids: number;
    try {
      solids = operation === 'union' ? countSolids(oc, result.shape) : 0;
    } catch (error) {
      releaseGeometryOnError(() => result.delete(), error);
    }
    if (solids > 1) {
      releaseGeometryOnError(() => result.delete(),
        new SolidGeometryFailure('geometry-pattern-detached', DETACHED_COPIES_MESSAGE, { solids: String(solids) }));
    }
    // 結果の面は写しの幾何を借りうるので、結果(作り手)を先に、写しを後に解放する。
    return { ...result, ...(origins === undefined ? {} : { origins }),
      delete: () => { try { result.delete(); } finally { owned.release(); } } };
  } catch (error) {
    releaseGeometryOnError(owned.release, error);
  }
}

/** 対象の形と、その名前の継ぎ(形状キャッシュの持ち物。借りるだけ)。 */
interface PatternTarget {
  readonly shape: TopoDS_Shape;
  readonly origins: CurrentOriginIndex | undefined;
}

/**
 * 並べる和・差を作る。`featureId` はこの段の id(工具 1 個の和・差と同じく、対象の名前の継ぎがあって id が分かるときだけ、
 * 写しが 1 個以上でも対象から来た物の名前を継ぐ)。対象・工具が面だけの形なら、今の和・差と同じ文で断る。
 */
export function booleanPattern(oc: OpenCascadeInstance, spec: PatternBooleanFields, transforms: readonly RigidTransformSpec[],
  target: PatternTarget, tool: TopoDS_Shape, featureId?: string): BooleanResult {
  const operation = assertPatternContract(spec, transforms);
  if (shapeBodyKind(oc, target.shape) !== 'solid' || shapeBodyKind(oc, tool) !== 'solid') throw new SolidGeometryFailure('geometry-open-solid', OPEN_FACES_NOT_SUPPORTED);
  const naming = featureId !== undefined && target.origins?.state === 'tracked'
    ? { featureId, targetOrigins: target.origins } : undefined;
  return transforms.length === 0
    ? carryTarget(oc, target.shape, target.origins)
    : combineCopies(oc, operation, target.shape, tool, transforms, naming);
}
